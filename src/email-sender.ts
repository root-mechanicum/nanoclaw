/**
 * Email Sender — thin nodemailer SMTP wrapper.
 */
import nodemailer from 'nodemailer';

import { logger } from './logger.js';

export interface EmailSenderOpts {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  fromAddress: string;
  fromName: string;
}

export class EmailSender {
  private transport: nodemailer.Transporter;
  private from: string;

  constructor(opts: EmailSenderOpts) {
    this.transport = nodemailer.createTransport({
      host: opts.smtpHost,
      port: opts.smtpPort,
      secure: opts.smtpPort === 465,
      auth: { user: opts.smtpUser, pass: opts.smtpPass },
    });
    this.from = `${opts.fromName} <${opts.fromAddress}>`;
  }

  async send(args: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    replyTo?: string;
  }): Promise<{ messageId: string }> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: args.to,
      subject: args.subject,
      text: args.body,
      cc: args.cc || undefined,
      replyTo: args.replyTo || undefined,
    });
    logger.info({ messageId: info.messageId, to: args.to }, 'Email sent');
    return { messageId: info.messageId };
  }

  async verify(): Promise<boolean> {
    try {
      await this.transport.verify();
      logger.info('SMTP connection verified');
      return true;
    } catch (err) {
      logger.error({ err }, 'SMTP verification failed');
      return false;
    }
  }
}
