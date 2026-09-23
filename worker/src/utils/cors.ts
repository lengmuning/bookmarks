// Extensions with host_permissions and the macOS app are not subject to CORS;
// these headers only matter for extension pages that send a preflight anyway.
// They are not an access control: the device token is.

function isExtensionOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return (
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://") ||
    origin.startsWith("safari-web-extension://")
  );
}

// Copies the response: headers of a Response returned by a Durable Object
// stub are immutable.
export function applyCors(req: Request, res: Response): Response {
  const out = new Response(res.body, res);
  const origin = req.headers.get("Origin");
  if (isExtensionOrigin(origin)) {
    out.headers.set("Access-Control-Allow-Origin", origin!);
    out.headers.set("Vary", "Origin");
  }
  out.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  out.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  out.headers.set("Access-Control-Max-Age", "86400");
  return out;
}
