const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";

/* Executes a single tool call and returns a JSON-serializable result.
   Throws on hard failures so the caller can send the error back to
   the model as a tool result. */
export async function executeTool(name, args) {
  if (name === "web_search") return await executeWebSearch(args);
  if (name === "web_fetch") return await executeWebFetch(args);
  if (name === "create_file") return executeCreateFile(args);
  throw new Error(`Unknown tool: ${name}`);
}

async function executeWebSearch(args) {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query is required");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(`${NINEROUTER_BASE}/v1/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: String(args.model || "gemini"),
        query,
        search_type: "web",
        max_results: Math.min(Math.max(Number(args.max_results) || 5, 1), 10)
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Search HTTP ${r.status}`);
    const j = await r.json();
    return {
      ok: true,
      query,
      answer: (j.answer && j.answer.text) ? j.answer.text : "",
      sources: Array.isArray(j.results)
        ? j.results.slice(0, 10).map(x => ({ title: x.title || "", url: x.url || "" })).filter(x => x.url)
        : []
    };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("Search timed out");
    throw e;
  }
}

async function executeWebFetch(args) {
  const url = String(args.url || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("valid url is required");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(`${NINEROUTER_BASE}/v1/web/fetch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "jina-reader",
        url,
        format: "markdown",
        max_characters: 0
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Fetch HTTP ${r.status}`);
    const j = await r.json();
    const text = (j.content && j.content.text) ? j.content.text : "";
    return {
      ok: true,
      url: j.url || url,
      title: j.title || url,
      length: (j.content && j.content.length) || text.length,
      content: text.slice(0, 20000)
    };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("Fetch timed out");
    throw e;
  }
}

function executeCreateFile(args) {
  const filename = String(args.filename || "file.txt").slice(0, 200);
  const mime = String(args.mime || "text/plain").slice(0, 100);
  const content = String(args.content || "");
  return {
    ok: true,
    filename,
    mime,
    size: content.length,
    action: "download"
  };
}
