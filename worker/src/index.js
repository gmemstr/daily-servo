import index from "./index.html";
import { IttyRouter, json, error, withParams } from 'itty-router'

const ROUTER = IttyRouter();
const CACHE = caches.default;

const SNAPSHOT_PREFIX = "snapshot:";
const SNAPSHOT_KEYS = { prefix: SNAPSHOT_PREFIX };
const WEBHOOK_PREFIX = "webhook:";
const WEBHOOK_KEYS = { prefix: WEBHOOK_PREFIX };

async function withCache(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const cacheUrl = new URL(request.url);

  // Construct the cache key from the cache URL
  const cacheKey = new Request(cacheUrl.toString(), request);
  let response = await CACHE.match(cacheKey);

  if (response) {
	return response;
  }

  request.cacheKey = cacheKey;
}

async function snapshot(request, env, ctx, date = "LATEST") {
  const kv = env.KV_STORE;
  const bucket = env.R2_BUCKET;

  const { value, metadata } = await kv.getWithMetadata(`${SNAPSHOT_PREFIX}${date}`);
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
  ctx.waitUntil(CACHE.put(request.cacheKey, response.clone()));
  return response
}

async function latest(request, env) {
  let l = await snapshot();
  const response = new Response(JSON.stringify(l), {
	headers: { "Content-Type": "application/json",
			   "Cache-Control": "s-maxage=3600"}
  });
  ctx.waitUntil(CACHE.put(request.cacheKey, response.clone()));
  return response;
}

async function snapshotList(request, env, ctx) {
  const kv = env.KV_STORE;

  let list = await kv.list(SNAPSHOT_KEYS);

  let filtered = await Promise.all(
	list.keys.filter((value) => value.name != `${SNAPSHOT_PREFIX}LATEST`)
	  .map(async (value) => {
		const v = await kv.get(value.name);
		return {
		  date: value.name.replace(`${SNAPSHOT_PREFIX}`, ""), hash: v
		} } ));
  console.log(filtered)
  const response = new Response(JSON.stringify({
	latest: await kv.get(`${SNAPSHOT_PREFIX}LATEST`),
	list: filtered,
  }), {
	headers: { "Content-Type": "application/json",
			   "Cache-Control": "s-maxage=3600"}
  });
  ctx.waitUntil(CACHE.put(request.cacheKey, response.clone()));
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
  let latest = await kv.get(`${SNAPSHOT_PREFIX}LATEST`);
  if (latest != hash) {
	await bucket.put(`${hash}.png`, file);
	let webhooks = kv.list(WEBHOOK_KEYS);
	await Promise.all(webhooks.keys.map(async key => {
	  let full = await kv.get(key.name);
	  let webhook = JSON.parse(full.value);
	  await env.WEBHOOKS_QUEUE.send({
		type: webhook.type,
		url: webhook.url,
		auth: webhook.auth ?? "",
		hash: hash,
		date: date,
		file: `https://daily-servo-r2.gmem.ca/${hash}.png`
	  });
	}));
  }

  await kv.put(`${SNAPSHOT_PREFIX}LATEST`, hash, {
	metadata: { date: date }
  });
  // Keep for 1 year.
  await kv.put(`${SNAPSHOT_PREFIX}${date}`, hash, { expirationTtl: 31_536_000 });

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

async function migrateKeys(request, env, ctx) {
  const kv = env.KV_STORE;
  let list = await kv.list();
  await Promise.all(list.keys.map(async key => {
	let full = await kv.getWithMetadata(key.name);
	await kv.put(`${SNAPSHOT_PREFIX}${key.name}`, full.value, { expiration: key.expiration, metadata: key.metadata });
	await kv.delete(key.name);
  }));

  return new Response(JSON.stringify({}), { status: 200, headers: {"Content-Type": "application/json"} });
}

ROUTER
  .get("/", withCache, renderIndex)
  .get("/latest", withCache, latest)
  .get("/latest.json", withCache, snapshot)
  .get("/list.json", withCache, snapshotList)
  .post("/new", withAuth, newSnapshot)
  // .get("/migrate", withAuth, migrateKeys)
  .get("*", withCache, specificSnapshot)

export default {
  fetch: (request, ...args) =>
  ROUTER
    .fetch(request, ...args)
    .then(json)
    .catch(error),
  async queue(batch, env) {
	const { tag } = env.CF_VERSION_METADATA;

	for (const msg of batch.messages) {
	  let content = msg.body;
	  let payload = "Daily Servo image hash changed!";
	  let content_type = "text/plain";

	  if (content.type == "discord") {
		payload = {
		  content: `[Daily Servo](<https://servo.gmem.ca>) update ${content.date} (${content.hash})`,
		  embeds: [ {title: `${content.date} snapshot`, image: { url: content.file }, type: "image" } ],
		};
		content_type = "application/json";
	  }
	  if (content.type == "gotosocial") {
		payload = {
		  status: `[Daily Servo](<https://servo.gmem.ca>) update ${content.date} (${content.hash})\n\n${content.file}`,
		  content_type: 'text/markdown',
		};
		content_type = "application/json";
	  }
	  let response = await fetch(`${content.url}`, {
		method: "POST",
		body: JSON.stringify(payload),
		headers: {
          "X-Source": "Cloudflare-Workers",
		  "User-Agent": `DAILY-SERVO ${tag}`,
		  "Content-Type": content_type,
		  ...(content.auth != "" && { "Authorization": env[content.auth] })
		},
      });
	  if (response.ok) {
		msg.ack();
	  } else {
		msg.retry({delaySeconds: 600});
	  }
    }
  }
}
