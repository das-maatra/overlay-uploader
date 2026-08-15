/**
 * The bucket side of the overlay uploader.
 *
 * The page this serves is static and lives on GitHub Pages, so it cannot hold a
 * credential: anything shipped to a browser is readable by whoever receives it.
 * This Worker holds the access instead, and it holds it as an R2 *binding*,
 * which means no access key or secret exists anywhere in this project. Cloudflare
 * hands the bucket to the running Worker directly. There is nothing here to leak
 * and nothing to rotate.
 *
 * The phrase in the link is what stands in for a login. It arrives as a header,
 * never as a query string, so it stays out of request logs and out of Referer
 * headers on the way to anywhere else. It is a Worker secret rather than a var,
 * so it is not in this repository either.
 *
 * Uploads are checked again here, not only in the browser. The page's own check
 * is what gives a designer a useful error message; this one is what makes the
 * rule true, because anyone can call a Worker with curl.
 */

// Both buckets, and the exact frame each one takes. These numbers are the
// output presets in backend/lighting/overlay.py: a template only lines up at
// the size it was drawn for, and the booth composites it without rescaling, so
// a frame of the wrong size is not slightly off, it is unusable. The booth
// silently saves such a photo unframed, which is the failure this rejects.
const TYPES = {
  standard: { binding: 'STANDARD', width: 1800, height: 1200 },
  member: { binding: 'MEMBER', width: 3000, height: 2000 },
};

// Frames are a few tens of kB. A ceiling well above that costs nothing and
// stops the endpoint being useful to anyone who finds the phrase and wants to
// fill the account with something else.
const MAX_BYTES = 12 * 1024 * 1024;

// Flat at the root, PNG only, and no path separators. The booth's lister
// ignores anything with a slash in the key, so a nested upload would vanish
// from the picker with no explanation. The name becomes the label in the
// booth's dropdown, so it is also what a BA reads.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,60}\.png$/;

const json = (data, status, extra) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });

/** Origins allowed to call this, as a comma separated var. A list rather than a
 *  single value so the page can move between GitHub accounts with both live at
 *  once, instead of a move needing a flag day. Not a security boundary: CORS is
 *  enforced by browsers and ignored by curl. The phrase is the boundary. */
function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const ok = allowed.includes(origin);
  return {
    'access-control-allow-origin': ok ? origin : allowed[0] || '',
    'access-control-allow-methods': 'GET,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-overlay-key',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

/** Compare the supplied phrase against the real one without leaking how much of
 *  it matched. Both are hashed first so the comparison runs over two fixed
 *  length digests: comparing the raw strings would return early on the first
 *  wrong character, and would also reveal the length. */
async function phraseOk(supplied, expected) {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied || '')),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Read a PNG's header and say whether it is the right size and can carry
 * transparency.
 *
 * Deliberately parsed here rather than trusted from the browser. The page runs
 * the same check to give a designer a sentence they can act on, but a Worker is
 * reachable by anything that can make an HTTP request, so the rule has to hold
 * on this side too.
 *
 * A PNG is an 8 byte signature then the IHDR chunk, whose payload is width and
 * height as big endian 32 bit integers, bit depth, then colour type. Colour
 * type 6 is truecolour with alpha and 4 is greyscale with alpha; the rest carry
 * no alpha channel at all. The booth reads a frame with cv2.IMREAD_UNCHANGED
 * and saves the photo unframed when it comes back with three channels, on the
 * grounds that a frame with no transparency would hide the photograph
 * completely.
 */
function inspectPng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33) return { ok: false, why: 'That file is too small to be a PNG.' };
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) return { ok: false, why: 'That is not a PNG file.' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colourType = bytes[25];
  return { ok: true, width, height, alpha: colourType === 6 || colourType === 4 };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // Answered before the phrase is checked, so the page can tell the difference
    // between "the Worker is not deployed" and "your link is wrong". Says
    // nothing about the buckets.
    if (path === '/api/health') {
      return json({ ok: true }, 200, cors);
    }

    if (!(await phraseOk(request.headers.get('x-overlay-key'), env.ACCESS_PHRASE))) {
      // No detail on purpose. A wrong phrase and a missing one are the same
      // answer, and neither says whether a bucket, a file or anything else
      // exists behind it.
      return json({ error: 'Not authorised.' }, 401, cors);
    }

    const type = url.searchParams.get('type');
    const spec = TYPES[type];
    if (!spec) {
      return json({ error: 'Unknown photo type.' }, 400, cors);
    }
    const bucket = env[spec.binding];
    if (!bucket) {
      return json({ error: `No bucket bound for ${type}.` }, 500, cors);
    }

    try {
      if (path === '/api/list' && request.method === 'GET') {
        // `include` is not optional here. R2 omits custom metadata from a
        // listing unless it is asked for, so without this every frame comes
        // back with no dimensions and the "wrong size" warning in the page can
        // never fire, which is the one thing the listing exists to show.
        const listed = await bucket.list({ limit: 500, include: ['customMetadata'] });
        const frames = await Promise.all(
          listed.objects
            .filter((o) => !o.key.includes('/') && o.key.toLowerCase().endsWith('.png'))
            .map(async (o) => {
              // Dimensions are recorded at upload, so anything this page put
              // there costs nothing to report. A frame uploaded through the
              // Cloudflare dashboard instead has no such metadata, and those
              // are exactly the ones worth checking, since nothing validated
              // them on the way in. So read their header rather than leaving
              // the size unknown: a PNG's width and height are in the first 33
              // bytes, and a ranged read costs one cheap operation instead of
              // pulling a whole file back.
              let width = Number(o.customMetadata?.width) || null;
              let height = Number(o.customMetadata?.height) || null;
              if (!width) {
                try {
                  const head = await bucket.get(o.key, { range: { offset: 0, length: 33 } });
                  if (head) {
                    const png = inspectPng(new Uint8Array(await head.arrayBuffer()));
                    if (png.ok) { width = png.width; height = png.height; }
                  }
                } catch {
                  // Left as null, which the page shows as "size unknown". Not
                  // worth failing a whole listing over.
                }
              }
              return {
                name: o.key,
                label: o.key.replace(/\.png$/i, ''),
                size: o.size,
                uploaded: o.uploaded,
                width,
                height,
              };
            }),
        );
        frames.sort((a, b) => a.label.localeCompare(b.label));
        return json({ type, expected: { width: spec.width, height: spec.height }, frames }, 200, cors);
      }

      const name = url.searchParams.get('name') || '';

      if (path === '/api/file' && request.method === 'GET') {
        if (!NAME_RE.test(name)) return json({ error: 'Bad name.' }, 400, cors);
        const obj = await bucket.get(name);
        if (!obj) return json({ error: 'No such frame.' }, 404, cors);
        // Fetched by script and turned into a blob URL rather than being put in
        // an <img src>, which is why this can require the header like everything
        // else. An <img> cannot send one, and the alternative was the phrase in
        // a query string on every thumbnail.
        return new Response(obj.body, {
          status: 200,
          headers: { ...cors, 'content-type': 'image/png', 'cache-control': 'no-store' },
        });
      }

      if (path === '/api/upload' && request.method === 'PUT') {
        if (!NAME_RE.test(name)) {
          return json(
            { error: 'Name must be letters, numbers, spaces, dashes or underscores, ending in .png' },
            400, cors,
          );
        }
        const buf = new Uint8Array(await request.arrayBuffer());
        if (buf.length === 0) return json({ error: 'Empty file.' }, 400, cors);
        if (buf.length > MAX_BYTES) return json({ error: 'That file is too large.' }, 413, cors);

        const png = inspectPng(buf);
        if (!png.ok) return json({ error: png.why }, 400, cors);
        if (png.width !== spec.width || png.height !== spec.height) {
          return json(
            {
              error: `${type} frames must be ${spec.width} by ${spec.height}. That one is ${png.width} by ${png.height}.`,
            },
            400, cors,
          );
        }
        if (!png.alpha) {
          return json(
            { error: 'That PNG has no transparency, so it would cover the whole photograph.' },
            400, cors,
          );
        }

        await bucket.put(name, buf, {
          httpMetadata: { contentType: 'image/png' },
          customMetadata: { width: String(png.width), height: String(png.height) },
        });
        return json({ ok: true, name }, 200, cors);
      }

      if (path === '/api/delete' && request.method === 'DELETE') {
        if (!NAME_RE.test(name)) return json({ error: 'Bad name.' }, 400, cors);
        const obj = await bucket.head(name);
        if (!obj) return json({ error: 'No such frame.' }, 404, cors);
        // Permanent, by choice. R2 has no undo without versioning, so the guard
        // against a mis-tap is in the page, which makes you type the name.
        await bucket.delete(name);
        return json({ ok: true, name }, 200, cors);
      }

      return json({ error: 'Not found.' }, 404, cors);
    } catch (e) {
      // The message is logged for whoever is looking at `wrangler tail`, and a
      // flat one goes back to the browser: an R2 error can name buckets and
      // keys, and this endpoint answers to anyone holding the link.
      console.error('overlay-uploader:', e && e.stack ? e.stack : String(e));
      return json({ error: 'Something failed on the server.' }, 500, cors);
    }
  },
};
