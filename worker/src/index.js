import index from "./index.html";
import { IttyRouter, json, error, withParams } from 'itty-router'

const router = IttyRouter();
const cache = caches.default;

async function withCache(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const cacheUrl = new URL(request.url);

  // Construct the cache key from the cache URL
  const cacheKey = new Request(cacheUrl.toString(), request);
  let response = await cache.match(cacheKey);

  if (response) {
	return response;
  }

  request.cacheKey = cacheKey;
}

async function snapshot(request, env, ctx, date = "LATEST") {
  const kv = env.KV_STORE;
  const bucket = env.R2_BUCKET;

  const { value, metadata } = await kv.getWithMetadata(date);
  if (value == null) {
	return {error: `${date} key not found`};
  }
  const object = await bucket.get(`${value}.png`);
  if (object === null) {
    return {error: `${date} object not found`};
  }

  if (metadata != null) {
	date = metadata.date;
  }

  return {
	hash: value,
	file: `https://daily-servo-r2.gmem.ca/${value}.png`,
	date: date,
  }
}

async function renderIndex(request, env, ctx) {
  let l = await snapshot(request, env, ctx);
  const response = new HTMLRewriter()
		.on("#date", {
		  element(element) {
			element.setInnerContent(l.date);
		  },
		})
		.on("#img", {
		  element(element) {
			element.setAttribute("src", l.file);
		  },
		})
		.on("#img-link", {
		  element(element) {
			element.setAttribute("href", l.file);
		  },
		})
		.transform(
		  new Response(index, { headers: { "Content-Type": "text/html",
										   "Cache-Control": "s-maxage=3600" } }),
		);
  ctx.waitUntil(cache.put(request.cacheKey, response.clone()));
  return response
}

async function latest(request, env) {
  let l = await snapshot();
  const response = new Response(JSON.stringify(l), {
	headers: { "Content-Type": "application/json",
			   "Cache-Control": "s-maxage=3600"}
  });
  ctx.waitUntil(cache.put(request.cacheKey, response.clone()));
  return response;
}

async function snapshotList(request, env, ctx) {
  const kv = env.KV_STORE;

  let list = await kv.list();
  let filtered = await Promise.all(
	list.keys.filter((value) => value.name != "LATEST")
	  .map(async (value) => { const v = await kv.get(value.name); return { date: value.name, hash: v } } ));
  const response = new Response(JSON.stringify({
	latest: await kv.get("LATEST"),
	list: filtered,
  }), {
	headers: { "Content-Type": "application/json",
			   "Cache-Control": "s-maxage=3600"}
  });
  ctx.waitUntil(cache.put(request.cacheKey, response.clone()));
  return response;
}

async function withAuth(request, env, ctx) {
  if (request.headers.get("Authorization") != env.API_TOKEN) {
	return new Response("Unauthorized", { status: 403 });
  }
}

async function newSnapshot(request, env, ctx) {
  const kv = env.KV_STORE;
  const bucket = env.R2_BUCKET;

  const body = await request.formData();
  const {
	date,
	hash,
	file
  } = Object.fromEntries(body)

  // Don't bother uploading to R2 if the hashes match.
  let latest = kv.get("LATEST");
  if (latest != hash) {
	await bucket.put(`${hash}.png`, file);
  }

  await kv.put("LATEST", hash, {
	metadata: { date: date }
  });
  // Keep for 1 year.
  await kv.put(`${date}`, hash, { expirationTtl: 31_536_000 });

  return new Response("Uploaded", { status: 201});
}

async function specificSnapshot(request, env, ctx) {
  const { pathname } = new URL(request.url);
  const response = await snapshot(request, env, ctx, pathname.replace("/", ""))
  if (response.error != undefined) {
	return new Response(JSON.stringify(response), { status: 404, headers: {"Content-Type": "application/json"} });
  }
  return response
}

router
  .get("/", withCache, renderIndex)
  .get("/latest", withCache, latest)
  .get("/latest.json", withCache, snapshot)
  .get("/list.json", withCache, snapshotList)
  .post("/new", withAuth, newSnapshot)
  .get("*", withCache, specificSnapshot)

export default {
  fetch: (request, ...args) =>
  router
    .fetch(request, ...args)
    .then(json)
    .catch(error)
}
