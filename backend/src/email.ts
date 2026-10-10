/**
 * Email Service
 * Handles sending emails for user invitations and password resets
 */

import nodemailer from "nodemailer";
import { publicSiteUrl } from "../../shared/deployment.js";
import { getCurrentConfig } from "./config.js";
import { error, info } from "./utils/logger.js";
import { translateBackend, getGlobalLocale } from "./i18n-backend.js";

export interface EmailConfig {
  enabled: boolean;
  smtp: {
    host: string;
    port: number;
    secure: boolean; // true for 465, false for other ports
    auth: {
      user: string;
      pass: string;
    };
  };
  from: {
    name: string;
    address: string;
  };
}

/**
 * Translation helper function with variable interpolation
 * Replaces {{variable}} placeholders in translated strings
 */
function t(key: string, variables?: Record<string, any>): string {
  const locale = getGlobalLocale();
  let translated = translateBackend(key, locale);
  
  // Interpolate variables
  if (variables) {
    Object.entries(variables).forEach(([varName, value]) => {
      translated = translated.replace(new RegExp(`{{${varName}}}`, 'g'), String(value));
    });
  }
  
  return translated;
}

/**
 * Get email configuration from config.json
 */
function getEmailConfig(): EmailConfig | null {
  const config = getCurrentConfig();
  return (config as any).email || null;
}

/**
 * Check if email service is enabled
 */
export function isEmailServiceEnabled(): boolean {
  const emailConfig = getEmailConfig();
  return emailConfig?.enabled === true;
}

/**
 * Generate invitation URL for manual sharing (when email is disabled)
 */
export function generateInvitationUrl(inviteToken: string): string {
  const config = getCurrentConfig();

  const frontendUrl = publicSiteUrl(config) || "http://localhost:3000";

  return `${frontendUrl}/invite/${inviteToken}`;
}

/**
 * Create nodemailer transporter
 */
function createTransporter() {
  const emailConfig = getEmailConfig();

  if (!emailConfig || !emailConfig.enabled) {
    return null;
  }

  return nodemailer.createTransport({
    host: emailConfig.smtp.host,
    port: emailConfig.smtp.port,
    secure: emailConfig.smtp.secure,
    auth: {
      user: emailConfig.smtp.auth.user,
      pass: emailConfig.smtp.auth.pass,
    },
  });
}

/**
 * Send user invitation email
 */
export async function sendInvitationEmail(
  toEmail: string,
  inviteToken: string,
  inviterName: string,
  language: string = 'en'
): Promise<boolean> {
  const transporter = createTransporter();
  const emailConfig = getEmailConfig();

  if (!transporter || !emailConfig) {
    error("[Email] Email service not configured - cannot send invitation");
    return false;
  }

  const config = getCurrentConfig();
  const siteName = config.branding?.siteName || "Galleria";

  const frontendUrl = publicSiteUrl(config) || "http://localhost:3000";

  const inviteUrl = `${frontendUrl}/invite/${inviteToken}`;

  // Get avatar URL
  const avatarPath = config.branding?.avatarPath || "/photos/avatar.png";
  const avatarUrl = `${frontendUrl}${avatarPath}`;

  // Get translations for the global language setting
  const locale = getGlobalLocale();
  info(`[Email] Sending invitation email in language: ${locale}`);

  const mailOptions = {
    from: `"${emailConfig.from.name}" <${emailConfig.from.address}>`,
    to: toEmail,
    subject: t('email.invitation.subject', { siteName }),
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${t('email.invitation.title', { siteName })}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 8px;
            padding: 30px;
            margin: 20px 0;
          }
          .avatar {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            object-fit: cover;
            margin-bottom: 20px;
          }
          .button {
            display: inline-block;
            background-color: #4ade80;
            color: white;
            text-decoration: none;
            padding: 12px 30px;
            border-radius: 6px;
            margin: 20px 0;
            font-weight: 600;
          }
          .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            font-size: 0.9em;
            color: #666;
          }
          .code {
            background-color: #f0f0f0;
            padding: 10px;
            border-radius: 4px;
            font-family: monospace;
            word-break: break-all;
            margin: 10px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <img src="${avatarUrl}" alt="${siteName}" class="avatar" />
          <h1>${t('email.invitation.title', { siteName })}</h1>
          <p>${t('email.invitation.greeting')}</p>
          <p>${t('email.invitation.body', { inviterName, siteName })}</p>
          <p>${t('email.invitation.instructions')}</p>
          <a href="${inviteUrl}" class="button">${t('email.invitation.button')}</a>
          <p>${t('email.invitation.orCopyLink')}</p>
          <div class="code">${inviteUrl}</div>
          <p><strong>${t('email.invitation.expiry')}</strong></p>
          <div class="footer">
            <p>${t('email.invitation.footerIgnore')}</p>
            <p>${t('email.invitation.footerAutomatic')}</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
${t('email.invitation.title', { siteName })}

${t('email.invitation.body', { inviterName, siteName }).replace(/<\/?strong>/g, '')}

${t('email.invitation.instructions')}
${inviteUrl}

${t('email.invitation.expiry')}

${t('email.invitation.footerIgnore')}
    `.trim(),
  };

  try {
    await transporter.sendMail(mailOptions);
    info(`[Email] Invitation sent to ${toEmail}`);
    return true;
  } catch (err) {
    error("[Email] Failed to send invitation:", err);
    return false;
  }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
  toEmail: string,
  resetToken: string,
  userName: string | null,
  language: string = 'en'
): Promise<boolean> {
  const transporter = createTransporter();
  const emailConfig = getEmailConfig();

  if (!transporter || !emailConfig) {
    error("[Email] Email service not configured - cannot send password reset");
    return false;
  }

  const config = getCurrentConfig();
  const siteName = config.branding?.siteName || "Galleria";

  const frontendUrl = publicSiteUrl(config) || "http://localhost:3000";

  const resetUrl = `${frontendUrl}/reset-password/${resetToken}`;

  // Get avatar URL
  const avatarPath = config.branding?.avatarPath || "/photos/avatar.png";
  const avatarUrl = `${frontendUrl}${avatarPath}`;

  // Get translations for the global language setting
  const locale = getGlobalLocale();
  info(`[Email] Sending password reset email in language: ${locale}`);
  
  const greeting = userName 
    ? t('email.passwordReset.greeting', { userName })
    : t('email.passwordReset.greetingFallback');

  const mailOptions = {
    from: `"${emailConfig.from.name}" <${emailConfig.from.address}>`,
    to: toEmail,
    subject: t('email.passwordReset.subject', { siteName }),
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${t('email.passwordReset.title')} - ${siteName}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 8px;
            padding: 30px;
            margin: 20px 0;
          }
          .avatar {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            object-fit: cover;
            margin-bottom: 20px;
          }
          .button {
            display: inline-block;
            background-color: #ef4444;
            color: white;
            text-decoration: none;
            padding: 12px 30px;
            border-radius: 6px;
            margin: 20px 0;
            font-weight: 600;
          }
          .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            font-size: 0.9em;
            color: #666;
          }
          .code {
            background-color: #f0f0f0;
            padding: 10px;
            border-radius: 4px;
            font-family: monospace;
            word-break: break-all;
            margin: 10px 0;
          }
          .warning {
            background-color: #fef2f2;
            border-left: 4px solid #ef4444;
            padding: 12px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <img src="${avatarUrl}" alt="${siteName}" class="avatar" />
          <h1>${t('email.passwordReset.title')}</h1>
          <p>${greeting}</p>
          <p>${t('email.passwordReset.body', { siteName })}</p>
          <p>${t('email.passwordReset.instructions')}</p>
          <a href="${resetUrl}" class="button">${t('email.passwordReset.button')}</a>
          <p>${t('email.passwordReset.orCopyLink')}</p>
          <div class="code">${resetUrl}</div>
          <div class="warning">
            <strong>${t('email.passwordReset.warningTitle')}</strong>
            <ul>
              <li>${t('email.passwordReset.warningExpiry')}</li>
              <li>${t('email.passwordReset.warningIgnore')}</li>
              <li>${t('email.passwordReset.warningNoChange')}</li>
            </ul>
          </div>
          <div class="footer">
            <p>${t('email.passwordReset.footerAutomatic')}</p>
            <p>${t('email.passwordReset.footerContact')}</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
${t('email.passwordReset.subject', { siteName })}

${greeting}

${t('email.passwordReset.body', { siteName }).replace(/<\/?strong>/g, '')}

${t('email.passwordReset.instructions')}
${resetUrl}

${t('email.passwordReset.warningTitle')}
- ${t('email.passwordReset.warningExpiry')}
- ${t('email.passwordReset.warningIgnore')}
- ${t('email.passwordReset.warningNoChange')}

${t('email.passwordReset.footerAutomatic')}
    `.trim(),
  };

  try {
    await transporter.sendMail(mailOptions);
    info(`[Email] Password reset sent to ${toEmail}`);
    return true;
  } catch (err) {
    error("[Email] Failed to send password reset:", err);
    return false;
  }
}

/**
 * Test email configuration
 */
export async function testEmailConfig(): Promise<{
  success: boolean;
  error?: string;
}> {
  const transporter = createTransporter();

  if (!transporter) {
    return { success: false, error: "Email service not configured" };
  }

  try {
    await transporter.verify();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Send a test email to verify SMTP configuration
 */
export async function sendTestEmail(toEmail: string, language: string = 'en'): Promise<boolean> {
  const transporter = createTransporter();
  const emailConfig = getEmailConfig();

  if (!transporter || !emailConfig) {
    error("[Email] Email service not configured - cannot send test email");
    return false;
  }

  const config = getCurrentConfig();
  const siteName = config.branding?.siteName || "Galleria";

  // Get translations for the global language setting
  const locale = getGlobalLocale();
  info(`[Email] Test email language: ${locale}`);
  
  const timestamp = new Date().toLocaleString();

  const mailOptions = {
    from: `"${emailConfig.from.name}" <${emailConfig.from.address}>`,
    to: toEmail,
    subject: t('email.test.subject', { siteName }),
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Test Email</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 8px;
            padding: 30px;
            margin: 20px 0;
          }
          .success {
            color: #22c55e;
            font-size: 3rem;
            margin-bottom: 20px;
          }
          .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            font-size: 0.9em;
            color: #666;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success">${t('email.test.success')}</div>
          <h1>${t('email.test.title')}</h1>
          <p>${t('email.test.body1')}</p>
          <p>${t('email.test.body2', { siteName })}</p>
          <div class="footer">
            <p>${t('email.test.footerTimestamp', { timestamp })}</p>
            <p>${t('email.test.footerIgnore')}</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
${t('email.test.title')}

${t('email.test.success')} ${t('email.test.body1')}

${t('email.test.body2', { siteName }).replace(/<\/?strong>/g, '')}

${t('email.test.footerTimestamp', { timestamp })}
${t('email.test.footerIgnore')}
    `.trim(),
  };

  try {
    await transporter.sendMail(mailOptions);
    info(`[Email] Test email sent to ${toEmail}`);
    return true;
  } catch (err) {
    error("[Email] Failed to send test email:", err);
    return false;
  }
}
