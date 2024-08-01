import index from "./index.html";

export default {
  async fetch(request, env, ctx) {
	const url = new URL(request.url);
    const { pathname } = url;

	const cacheUrl = new URL(request.url);

    // Construct the cache key from the cache URL
    const cacheKey = new Request(cacheUrl.toString(), request);
    const cache = caches.default;
    let response = await cache.match(cacheKey);
	if (response) {
	  return response;
	}

	const kv = env.KV_STORE;
	const bucket = env.R2_BUCKET;

	const snapshot = async(date = "LATEST") => {
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

	switch (pathname) {
	case "/": {
	  let l = await snapshot();
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
	  ctx.waitUntil(cache.put(cacheKey, response.clone()));
	  return response
	}
	case "/latest": {
	  let l = await latest();
	  if (l.error != undefined) {
		return new Response(JSON.stringify(l), {
		  status: 500,
		  headers: { "Content-Type": "application/json" }
		});
	  }
	  return Response.redirect(`${l.file}`, 302);
	}
	case "/latest.json": {
	  let l = await snapshot();
	  const response = new Response(JSON.stringify(l), {
		headers: { "Content-Type": "application/json",
				   "Cache-Control": "s-maxage=3600"}
	  });
	  ctx.waitUntil(cache.put(cacheKey, response.clone()));
	  return response;
	}
	case "/list.json": {
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
	  ctx.waitUntil(cache.put(cacheKey, response.clone()));
	  return response;
	}
	case "/new": {
	  if (request.method == "POST" && request.headers.get("Authorization") == env.API_TOKEN) {
		const body = await request.formData();
		const {
		  date,
		  hash,
		  file
		} = Object.fromEntries(body)
		await bucket.put(`${hash}.png`, file);
		await kv.put("LATEST", hash, {
		  metadata: { date: date }
		});
		// Keep for 1 year.
		await kv.put(`${date}`, hash, { expirationTtl: 31_536_000 });

		return new Response("Uploaded", { status: 201 });
	  } else {
		return new Response("Unauthorized", { status: 403 });
	  }
	}
	default:
	  let snap = await snapshot(pathname.replace("/", ""));
	  if (snap.error != undefined) {
		return new Response("Not found", { status: 404 });
	  }
	  const response = new Response(JSON.stringify(snap), {
		headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=3600" }
	  });
	  ctx.waitUntil(cache.put(cacheKey, response.clone()));
	  return response;
	}
  },
};
