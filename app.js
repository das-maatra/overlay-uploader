/**
 * The overlay uploader.
 *
 * Plain DOM, no framework and no build step. The booth compiles React in the
 * browser because it is a real application; this is two lists and an upload
 * box, and a framework would be most of its weight.
 *
 * Nothing secret is in this file. WORKER is a public address that refuses every
 * request without the phrase, and the phrase itself arrives in the link's
 * fragment, which a browser never sends to a server. So this repository can be
 * public, which is what free GitHub Pages requires.
 */

// Set this to the Worker's address after `wrangler deploy` prints it.
const WORKER = 'https://overlay-uploader.handandeye.workers.dev';

// The two buckets and the exact frame each takes. Repeated from the booth's
// OUTPUT_PRESETS and from the Worker, and checked in all three places on
// purpose: here so a designer gets a sentence they can act on before anything
// is uploaded, in the Worker because anyone can call it with curl, and in the
// booth because a frame can still arrive by other routes.
const TYPES = [
  { key: 'standard', title: 'Standard frames', width: 1800, height: 1200 },
  { key: 'member', title: 'Member frames', width: 3000, height: 2000 },
];

// The phrase is in the fragment rather than the path or the query. A path would
// have to exist as a folder in this public repository, which publishes it. A
// query string is sent to GitHub's servers and lands in their logs. The
// fragment is the one part of a URL that never leaves the browser.
const FRAGMENT = decodeURIComponent(location.hash.replace(/^#/, '')).trim();

// Set by local-config.js, which only serve.py serves, and only when it has a
// phrase to work with. It means this page is being served from a checkout on
// someone's Mac, and that server will attach the phrase to each API call
// itself.
//
// So requests go to /api on this same origin rather than to the Worker, and
// carry no phrase at all: the browser never receives one, and nothing has to be
// typed on any device that opens the page. Same origin also means no CORS in
// that path and no preflight.
//
// On GitHub Pages this file does not exist, the flag is undefined, and the
// phrase in the fragment is the only way in, exactly as before.
const PROXY = window.OVERLAY_PROXY === true;
const BASE = PROXY ? '' : WORKER;
const PHRASE = PROXY ? '' : FRAGMENT;
const AUTHED = PROXY || !!FRAGMENT;

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) n.append(k?.nodeType ? k : document.createTextNode(k));
  return n;
};
const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(0)} kB`);

async function api(path, { method = 'GET', body, type, name } = {}) {
  // Relative when proxied, absolute otherwise. new URL needs a base for the
  // relative case, and location.origin is the right one either way.
  const url = new URL(BASE + path, location.origin);
  if (type) url.searchParams.set('type', type);
  if (name) url.searchParams.set('name', name);
  const res = await fetch(url, {
    method,
    // No phrase when proxied: serve.py attaches it, and sending an empty one
    // here would be the browser holding a credential it has no need of.
    headers: PROXY ? {} : { 'x-overlay-key': PHRASE },
    body,
  });
  if (path === '/api/file') {
    if (!res.ok) throw new Error('Could not load the preview.');
    return res.blob();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

/**
 * Check a file in the browser before any of it is uploaded.
 *
 * This is the reason the tool exists. Uploading a wrong sized PNG through the
 * Cloudflare dashboard is accepted without complaint, and the booth's only
 * response is to save the visitor's photograph unframed, which nobody notices
 * until the emails have gone out.
 *
 * Three things are checked, and the third is one the booth itself does not
 * catch. A frame with an alpha channel that is fully opaque passes the booth's
 * test and then covers the photograph completely.
 */
async function validate(file, spec) {
  if (!/\.png$/i.test(file.name)) return 'Frames must be PNG files.';
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,60}\.png$/.test(file.name)) {
    return 'Use letters, numbers, spaces, dashes or underscores in the name.';
  }

  const buf = new Uint8Array(await file.slice(0, 33).arrayBuffer());
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 33 || sig.some((b, i) => buf[i] !== b)) return 'That is not a PNG file.';

  // Colour type lives at byte 25 of a PNG. 6 is truecolour with alpha, 4 is
  // greyscale with alpha; everything else has no alpha channel to composite
  // through, which is what the booth rejects.
  const colourType = buf[25];
  if (colourType !== 6 && colourType !== 4) {
    return 'That PNG has no transparency, so it would cover the whole photograph.';
  }

  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return 'That PNG could not be read.';
  if (bmp.width !== spec.width || bmp.height !== spec.height) {
    return `${spec.title} must be ${spec.width} by ${spec.height}. That one is ${bmp.width} by ${bmp.height}.`;
  }

  // Is the middle actually see-through? A frame is a border and a mark around
  // the edges, so its centre has to be transparent or the photograph never
  // shows. Sampled from the middle fifth rather than the whole image, which
  // would be a 6 megapixel read for a question this narrow.
  const w = Math.max(1, Math.round(bmp.width / 5));
  const h = Math.max(1, Math.round(bmp.height / 5));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, Math.round(bmp.width * 0.4), Math.round(bmp.height * 0.4), w, h, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  let clear = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) clear++;
  bmp.close();
  if (clear / (px.length / 4) < 0.5) {
    return 'The middle of that frame is not transparent, so it would hide the photograph.';
  }
  return null;
}

function message(where, text, kind) {
  where.replaceChildren(el('div', { className: `msg ${kind}` }, text));
}

function bucketSection(spec) {
  const grid = el('div', { className: 'grid' });
  const note = el('div');
  const count = el('span', { className: 'spec' });

  const section = el('section', { className: 'bucket' },
    el('div', { className: 'bucket-head' },
      el('h2', { className: 'caps' }, spec.title),
      count,
    ),
    grid,
    note,
  );

  // `keepNote` is for the reload that follows a successful upload or delete.
  // Without it the confirmation is posted and then wiped a few hundred
  // milliseconds later by this very function, so the frame appears and nothing
  // ever says the action worked.
  async function refresh(keepNote) {
    grid.replaceChildren(el('div', { className: 'empty' }, 'Loading...'));
    let data;
    try {
      data = await api('/api/list', { type: spec.key });
    } catch (e) {
      grid.replaceChildren();
      message(note, e.message, 'err');
      return;
    }
    if (!keepNote) note.replaceChildren();
    count.textContent = `${spec.width} x ${spec.height} - ${data.frames.length} frame${data.frames.length === 1 ? '' : 's'}`;

    if (!data.frames.length) {
      grid.replaceChildren(el('div', { className: 'empty' },
        'Nothing in this bucket yet. The booth will fall back to an unframed photo until a frame is added.'));
      return;
    }

    grid.replaceChildren(...data.frames.map((f) => {
      const thumb = el('div', { className: 'thumb' }, el('span', { className: 'loading' }, 'loading'));
      const wrong = f.width && (f.width !== spec.width || f.height !== spec.height);
      const del = el('button', { className: 'danger' }, 'Delete');

      // Previews are fetched rather than put in an <img src>, so the request can
      // carry the phrase as a header. An <img> cannot send one, and the
      // alternative was the phrase in a query string on every thumbnail, where
      // it would sit in logs.
      api('/api/file', { type: spec.key, name: f.name })
        .then((blob) => {
          const img = el('img', { src: URL.createObjectURL(blob), alt: f.label, loading: 'lazy' });
          thumb.replaceChildren(img);
        })
        .catch(() => thumb.replaceChildren(el('span', { className: 'loading' }, 'no preview')));

      del.onclick = async () => {
        // Typed, not tapped. Deleting is permanent here, R2 has no undo without
        // versioning, and this page is used on an iPad where a mis-tap is easy.
        const typed = prompt(
          `Deleting "${f.label}" cannot be undone.\n\nType the name to confirm:`,
        );
        if (typed === null) return;
        if (typed.trim() !== f.label) {
          message(note, `Not deleted: "${typed.trim()}" does not match "${f.label}".`, 'warn');
          return;
        }
        del.disabled = true;
        del.textContent = 'Deleting...';
        try {
          await api('/api/delete', { method: 'DELETE', type: spec.key, name: f.name });
          message(note, `Deleted ${f.label}.`, 'ok');
          refresh(true);
        } catch (e) {
          message(note, e.message, 'err');
          del.disabled = false;
          del.textContent = 'Delete';
        }
      };

      return el('div', { className: 'card' },
        thumb,
        el('div', { className: 'name' }, f.label),
        el('div', { className: 'meta' },
          wrong
            ? el('span', { className: 'bad' }, `${f.width} x ${f.height}, wrong size`)
            : `${kb(f.size)}${f.width ? ` - ${f.width} x ${f.height}` : ''}`,
        ),
        del,
      );
    }));
  }

  // --- upload ------------------------------------------------------------
  const input = el('input', { type: 'file', accept: 'image/png', multiple: true });
  const pick = el('button', { className: 'primary' }, 'Choose PNG files');
  // Two wordings, one shown per pointer type by the stylesheet. Telling someone
  // on a phone to drop a file onto a panel is not just useless, it points away
  // from the button that is their only way in.
  const drop = el('div', { className: 'drop' },
    el('p', {},
      el('span', { className: 'fine-only' },
        `Drop ${spec.width} x ${spec.height} PNGs here, with transparency`),
      el('span', { className: 'coarse-only' },
        `${spec.width} x ${spec.height} PNGs, with transparency`),
    ),
    pick, input,
  );
  section.append(drop);

  pick.onclick = () => input.click();
  input.onchange = () => { upload([...input.files]); input.value = ''; };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    upload([...e.dataTransfer.files]);
  });

  async function upload(files) {
    if (!files.length) return;
    const done = [];
    const failed = [];
    pick.disabled = true;
    for (const file of files) {
      pick.textContent = `Checking ${file.name}...`;
      const bad = await validate(file, spec);
      if (bad) { failed.push(`${file.name}: ${bad}`); continue; }
      pick.textContent = `Uploading ${file.name}...`;
      try {
        await api('/api/upload', { method: 'PUT', type: spec.key, name: file.name, body: file });
        done.push(file.name.replace(/\.png$/i, ''));
      } catch (e) {
        failed.push(`${file.name}: ${e.message}`);
      }
    }
    pick.disabled = false;
    pick.textContent = 'Choose PNG files';

    if (failed.length) {
      note.replaceChildren(el('div', { className: 'msg err' },
        ...failed.flatMap((f, i) => (i ? [el('br'), f] : [f]))));
    } else {
      message(note, `Uploaded ${done.join(', ')}. Reload the booth's page to see ${done.length === 1 ? 'it' : 'them'}.`, 'ok');
    }
    if (done.length) refresh(true);
  }

  refresh();
  return section;
}

function render() {
  const root = document.getElementById('root');

  if (!AUTHED) {
    // The whole page, not a disabled version of it. Nothing here works without
    // the phrase, and a screen of dead controls invites people to hunt for the
    // one that still does.
    root.replaceChildren(el('div', { className: 'gate' },
      el('h1', {}, 'Overlay frames'),
      el('p', {}, 'This link is incomplete. The address needs the phrase on the end of it, after the # sign.'),
      el('p', {}, el('code', {}, `${location.origin}${location.pathname}#your-four-words`)),
      el('p', {}, 'Ask whoever sent you here for the full link.'),
    ));
    return;
  }

  root.replaceChildren(
    el('header', {},
      el('h1', {}, 'Overlay frames'),
      el('span', { className: 'sub caps' }, 'The Hand & The Eye'),
    ),
    el('main', {}, ...TYPES.map(bucketSection)),
  );
}

render();
