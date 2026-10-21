// TEST MODULE — serves ONE static test-email page (nothing else) so Zoho Marketing Automation can
// fetch it as campaign content_url through a temporary tunnel. Remove after testing.
//   node scripts/test-email-page.mjs <port> <token> <name>
import http from "node:http";

const [port = "3999", token, name = "Jay Chaudhari"] = process.argv.slice(2);
if (!token || token.length < 20) {
  console.error("usage: node scripts/test-email-page.mjs <port> <random-token-20+> [name]");
  process.exit(1);
}
const safe = name.replace(/[<>&"]/g, "");
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Test email from Niveshaay Communication Center</title></head>
<body style="margin:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#101828">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e4e7ec">
<tr><td style="background:#1E3A5F;color:#ffffff;padding:20px 24px;border-radius:10px 10px 0 0;font-size:18px;font-weight:bold">Niveshaay Communication Center</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.6">
<p>Hi ${safe},</p>
<p>This is a <strong>test email</strong> sent through Zoho Marketing Automation from the Niveshaay Communication Center test dashboard, at the same time as the WhatsApp onboarding message.</p>
<p>If you received this, the email integration works end to end.</p>
<p style="color:#5d6b82;font-size:13px">Test only — sent to an approved internal address. No client received this message.</p>
</td></tr></table></td></tr></table></body></html>`;

http
  .createServer((req, res) => {
    const ok = req.method === "GET" && req.url === `/${token}.html`;
    console.log(new Date().toISOString(), req.method, req.url?.slice(0, 80), ok ? 200 : 404, req.headers["user-agent"]?.slice(0, 60));
    if (!ok) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }).end(html);
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`test email page on http://127.0.0.1:${port}/${token.slice(0, 6)}….html`));
