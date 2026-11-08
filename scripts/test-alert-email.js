/* ============================================================
   test-alert-email.js
   Sends a single test email using the same SMTP secrets as the
   herd alert checks, so you can confirm the Gmail setup works
   without waiting for a real down-cow/geofence/battery alert.
   Run it from the Actions tab: "Test alert email" -> Run workflow.
   ============================================================ */
const nodemailer = require("nodemailer");
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REMINDER_TO, REMINDER_FROM } = process.env;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !REMINDER_TO) {
  console.error("Missing SMTP config. Add the REMINDER_TO, SMTP_USER and SMTP_PASS repository secrets, then run again.");
  process.exit(1);
}

(async () => {
  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT) || 587, secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({
    from: REMINDER_FROM || SMTP_USER,
    to: REMINDER_TO,
    subject: "✅ Cattle Tracker — test alert email",
    html: '<div style="font-family:Arial,sans-serif;max-width:560px">' +
      '<h2 style="color:#2e5a34">✅ Email alerts are working</h2>' +
      '<p>This is a test from your Cattle Tracker. If this landed in your inbox, your down-cow, ' +
      'geofence, and battery alerts will reach you here too.</p>' +
      '<p style="color:#888;font-size:12px">Sent ' + new Date().toLocaleString() + " — Cattle Tracker</p></div>",
  });
  console.log("Test email sent to " + REMINDER_TO);
})().catch((e) => { console.error(e); process.exit(1); });
