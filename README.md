Daily Servo
===

Despite the name, this doesn't (technically) render Servo images daily (at least, not automatically)

Still very much a work in progress but is generally at a point where you can fork and use it.

About
---

Various tools for rendering and sharing snapshots of websites using Servo, primarily to track [my own site](https://servo.arch.dog)
over time.

`main.py` is a wrapper around Docker for rendering a screenshot then producing a hash of the image. This can help
indicate when Servo's rendering has changed. If you get inconsistant results with the same version and site, see
[this GitHub issue](https://github.com/servo/servo/issues/32771).

`worker/` is a small Cloudflare Worker for collecting and serving the images. Currently requires manual uploading.

Worker
---

The main purpose of the worker is to serve as a repository for snapshots over time. It stores images in Cloudflare R2 and
pointers to the image in KV, with a dedicated `LATEST` key pointing to the latest snapshot. The hash of the image is used as
the filename (it could technically be anything, but it *should* be the hash).

### Setup

You'll need a KV namespace and R2 bucket, which you can swap out in `worker/wrangler.toml`. You'll
also want to set an API token with `npx wrangler secret put API_TOKEN`.

You can then POST to it!

```
 curl -X POST -H "Authorization: API_TOKEN" \
   https://daily-servo.your-name.workers.dev/new \
   -F date=(date -I) -F hash=098f6bcd4621d373cade4e832627b4f6 \
   -F file=@file.png
```

The hash is md5 since that's "good enough" for detecting duplicate files at the moment, but it could easily be swapped out.

### Endpoints

A few endpoints are exposed

| endpoint | about |
|----------|-------|
|`/`|Basic HTML page|
|`/latest`|Will `302` redirect to the latest snapshot's image|
|`/latest.json`|Latest snapshot info with the hash, file URL and date|
|`/list.json`|List of all snapshots (dates and hashes), along with a `latest` pointer|
|`/new`|`POST` endpoint for uploading a new snapshot. Authorized endpoint|
|`/<ISO-8601 date>`|Specific snapshot in JSON format|

#### `/latest.json` | `/<ISO-8601 date>`

```json
{
  "hash": string,
  "file": string,
  "date": ISO-8601 string
}
```

#### `/list.json`

```json
{
  "latest": string,
  "list": [
    {
      "date": ISO-8601 string,
      "hash": string
    }
  ]
}
```
