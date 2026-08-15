# Overlay uploader

Uploads and manages the photo booth's frame designs in the two R2 buckets the
booth reads: `photo-1-standard` and `photo-1-member`.

The page is static and served by GitHub Pages. It holds no credential, because
anything shipped to a browser is readable by whoever receives it. A Cloudflare
Worker does everything that touches a bucket, and it reaches R2 through a
*binding* rather than an API token, so no access key exists in this project at
all.

## The link is the login

There is no sign in. The address carries a phrase after a `#`, which the browser
never sends to any server, and the Worker refuses every request that does not
carry it:

    https://das-maatra.github.io/overlay-uploader/#your-four-words

Without the phrase the page says so and does nothing. The phrase is a Worker
secret, so it is not in this repository either.

## What it refuses

A frame must be exactly the size its photo type expects, and it must be
transparent. The booth composites a frame without rescaling it and saves the
photograph **unframed** when the file is wrong, which nobody notices until the
emails have gone out. So an upload is checked before it is sent, and again in
the Worker because anyone can call a Worker with curl.

| Photo type | Bucket | Size |
| --- | --- | --- |
| Standard | `photo-1-standard` | 1800 x 1200 |
| Member | `photo-1-member` | 3000 x 2000 |

Both must be PNGs with a real alpha channel, and their middles must be
see-through. That last check catches something the booth does not: a frame whose
alpha channel is fully opaque passes the booth's test and then hides the
photograph completely.

Deleting is permanent. R2 has no undo without versioning, so the page makes you
type the frame's name first.

## Running it from a checkout

    ./serve.sh

Then open `http://localhost:8081/#the-hand-the-eye`.

Port 8081 specifically, because that is the origin named in the Worker's
`ALLOWED_ORIGINS`. Served on any other port the browser blocks every request as
a cross origin one. It binds to 127.0.0.1 rather than the default 0.0.0.0, since
Python's `http.server` hands out any file under this folder, `.git` included, to
whoever asks, and none of that needs to be reachable from the venue wifi.

**This is not a test environment.** Same page, same Worker, same buckets. A
delete here is a delete from the museum's booth. The only thing that differs is
where the HTML came from.

## Deploying

The page deploys itself: pushing to `main` publishes it through GitHub Pages.

The Worker is separate and needs a Cloudflare login.

    cd worker
    npx wrangler login
    npx wrangler secret put ACCESS_PHRASE      # paste the four words
    npx wrangler deploy

`wrangler deploy` prints the Worker's address. Put it in `WORKER` at the top of
`app.js`, commit, and push.

`ALLOWED_ORIGINS` in `wrangler.toml` lists the page origins allowed to call the
Worker from a browser. It is a list so the page can move to another GitHub
account with both live at once. It is not the security boundary: CORS is
enforced by browsers and ignored by everything else. The phrase is the boundary.

## What the booth does with all this

Nothing needs changing there. The booth rescans a bucket when its page loads and
when the local/online switch is flipped. A frame you replace is noticed by its
ETag and re-fetched. A frame you delete that was the selected one is corrected to
the default on the next scan, rather than sitting in the picker as a dead entry.

The booth's own R2 credentials are **Object Read only** and should stay that
way. It never writes a frame. The ability to delete one lives only in this
Worker, behind the phrase.
