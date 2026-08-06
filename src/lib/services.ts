import { v2 as cloudinary } from 'cloudinary'
import nodemailer from 'nodemailer'
import Stripe from 'stripe'
import { env } from '../config/env.js'

cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET })
export { cloudinary }
export const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null
export const mailer = env.SMTP_HOST ? nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined }) : null
export async function sendMail(to: string, subject: string, html: string, attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>) { if (!mailer) return; await mailer.sendMail({ from: env.MAIL_FROM, to, subject, html, attachments }) }
