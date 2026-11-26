import type { OtpPurpose } from "./auth";

const actionByPurpose: Record<OtpPurpose, string> = {
  signin: "sign in to QC Warehouse",
  register: "finish creating your account",
  link: "connect a sign-in method",
  change_email: "confirm the primary email change",
  change_email_new: "verify your new primary email",
  promote_email: "confirm the primary email change",
  backup_email: "verify your backup email",
  recovery: "verify your account recovery email",
  recovery_status: "view your account recovery status",
  reauth: "confirm your identity",
  unlink_identity: "remove a sign-in method",
};

export function renderVerificationEmail(code: string, purpose: OtpPurpose, lifetimeMinutes: number) {
  const subject = "Your QC Warehouse verification code";
  const instruction = `Enter this code to ${actionByPurpose[purpose]}.`;
  const expiry = `This code expires in ${lifetimeMinutes} minutes.`;
  const safety = "If you didn’t request this code, you can ignore this email. Never share your code.";
  const text = ["QC Warehouse", "Your verification code", instruction, code, expiry, safety].join("\n\n");
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f1f4f9;color:#17233b;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f4f9;">
    <tr><td align="center" style="padding:24px 12px;">
      <!--[if mso]><table role="presentation" width="520" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border:1px solid #dbe4f0;border-radius:12px;text-align:left;">
        <tr><td style="padding:22px 24px;border-bottom:1px solid #dbe4f0;font-size:19px;line-height:1.3;font-weight:bold;color:#14213a;">QC Warehouse</td></tr>
        <tr><td style="padding:24px;color:#17233b;">
          <h1 style="margin:0 0 10px;font-size:25px;line-height:1.25;">Your verification code</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;">${instruction}</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#edf2ff;border:1px solid #d4dffc;border-radius:8px;">
            <tr><td align="center" style="padding:14px 10px;color:#17316f;font-family:Consolas,Monaco,monospace;font-size:32px;line-height:1.3;font-weight:bold;letter-spacing:0.1em;">${code}</td></tr>
          </table>
          <p style="margin:12px 0 0;font-size:14px;line-height:1.5;color:#435571;">${expiry}</p>
        </td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #dbe4f0;font-size:13px;line-height:1.55;color:#435571;">${safety}</td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}
