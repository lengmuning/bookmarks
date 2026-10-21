// The public home page at "/": an introduction to the project with download
// links. Static files from public/ (index.html, and public/site/ for its
// stylesheet, script and icon), served with strict page headers. The page
// fetches nothing, so the policy allows only its own files.

const SITE_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Revalidated on every visit, so a deploy shows up right away.
  "Cache-Control": "no-cache",
};

export function isSitePath(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/site/");
}

export async function handleSite(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withSiteHeaders(Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET, HEAD" } }));
  }
  return withSiteHeaders(await env.ASSETS.fetch(request));
}

function withSiteHeaders(response: Response): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(SITE_HEADERS)) copy.headers.set(name, value);
  return copy;
}
