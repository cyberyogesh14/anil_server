const crypto = require('crypto');
const User = require('../models/User');
const Order = require('../models/Order');
const EmailCampaign = require('../models/EmailCampaign');
const emailService = require('../services/emailService');
const sanitizeHtml = require('sanitize-html');

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

const SANITIZE_OPTIONS = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'p',
    'br',
    'hr',
    'strong',
    'b',
    'em',
    'i',
    'u',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'span',
    'div',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    }),
  },
  selfClosing: ['br', 'hr'],
};

const VALID_SEGMENTS = [
  'all',
  'marketing',
  'new',
  'with_orders',
  'no_orders',
  'delivered_orders',
  'pending_orders',
];

function sanitizeEmailContent({ subject, bodyHtml }) {
  const cleanedSubject = String(subject || '').trim().slice(0, 120);
  const cleanedBody = sanitizeHtml(String(bodyHtml || ''), SANITIZE_OPTIONS).trim();

  if (!cleanedSubject) {
    const error = new Error('Subject is required');
    error.statusCode = 400;
    throw error;
  }
  if (!cleanedBody) {
    const error = new Error('Email content is required');
    error.statusCode = 400;
    throw error;
  }
  if (cleanedBody.length > 30000) {
    const error = new Error('Email content is too long');
    error.statusCode = 400;
    throw error;
  }

  return { subject: cleanedSubject, bodyHtml: cleanedBody };
}

const buildRecipientQueryAsync = async (params) => {
  if (!VALID_SEGMENTS.includes(params.segment)) {
    const error = new Error('Invalid audience segment');
    error.statusCode = 400;
    throw error;
  }

  const filter = {
    role: 'customer',
    isActive: true,
    marketingConsent: true,
  };

  if (params.segment === 'new') {
    filter.createdAt = {
      $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    };
  }

  if (params.fromDate) {
    const from = new Date(params.fromDate);
    if (!isNaN(from)) {
      filter.createdAt = { ...(filter.createdAt || {}), $gte: from };
    }
  }
  if (params.toDate) {
    const to = new Date(params.toDate);
    if (!isNaN(to)) {
      filter.createdAt = {
        ...(filter.createdAt || {}),
        $lte: new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1),
      };
    }
  }

  const orderFilters = {
    with_orders: {},
    delivered_orders: { orderStatus: 'delivered' },
    pending_orders: { orderStatus: 'pending' },
  };

  if (orderFilters[params.segment] || params.segment === 'no_orders') {
    const orderMatch = orderFilters[params.segment] || {};
    const userIds = await Order.distinct('user', orderMatch);
    if (params.segment === 'no_orders') {
      filter._id = { $nin: userIds };
    } else {
      filter._id = { $in: userIds };
    }
  }

  return filter;
};

exports.getAudience = async (req, res, next) => {
  try {
    const { segment, fromDate, toDate } = req.query;
    const normalized = VALID_SEGMENTS.includes(segment) ? segment : 'all';

    const filter = await buildRecipientQueryAsync({
      segment: normalized,
      fromDate,
      toDate,
    });

    const count = await User.countDocuments(filter);

    res.json({
      success: true,
      data: {
        segment: normalized,
        count,
        filters: {
          fromDate: fromDate || null,
          toDate: toDate || null,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.sendTest = async (req, res, next) => {
  try {
    const { subject, bodyHtml } = req.body;
    const { subject: cleanSubject, bodyHtml: cleanBody } = sanitizeEmailContent({
      subject,
      bodyHtml,
    });

    const admin = await User.findById(req.user._id);
    const sent = await emailService.sendTestEmail({
      to: admin.email,
      customerName: admin.name,
      subject: cleanSubject,
      bodyHtml: cleanBody,
    });

    if (!sent) {
      console.warn(
        'Test email not sent (SMTP not configured). Subject:',
        cleanSubject
      );
    }

    res.json({
      success: true,
      message: sent
        ? 'Test email sent'
        : 'Test email queued (email provider not configured yet)',
    });
  } catch (error) {
    next(error);
  }
};

exports.sendCampaign = async (req, res, next) => {
  try {
    const { subject, bodyHtml, segment, fromDate, toDate } = req.body;
    const normalized = VALID_SEGMENTS.includes(segment) ? segment : 'all';

    const { subject: cleanSubject, bodyHtml: cleanBody } = sanitizeEmailContent({
      subject,
      bodyHtml,
    });

    const filter = await buildRecipientQueryAsync({
      segment: normalized,
      fromDate,
      toDate,
    });

    const recipients = await User.find(filter)
      .select('_id email name')
      .lean();

    if (recipients.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          'No eligible recipients for this audience. Promotional emails are only sent to active customers who have opted in.',
      });
    }

    const campaignId = `CMP-${Date.now().toString(36).toUpperCase()}-${crypto
      .randomBytes(3)
      .toString('hex')
      .toUpperCase()}`;

    const campaign = await EmailCampaign.create({
      campaignId,
      subject: cleanSubject,
      bodyHtml: cleanBody,
      audience: normalized,
      filters: {
        fromDate: fromDate || null,
        toDate: toDate || null,
      },
      recipientCount: recipients.length,
      sentCount: 0,
      failedCount: 0,
      status: 'queued',
      createdBy: req.user._id,
    });

    const recipientIds = recipients.map((r) => r._id.toString());
    const recipientEmailMap = new Map(
      recipients.map((r) => [r._id.toString(), r])
    );

    setImmediate(async () => {
      let sentCount = 0;
      let failedCount = 0;
      try {
        await EmailCampaign.findOneAndUpdate(
          { campaignId },
          { status: 'sending' }
        );

        for (let i = 0; i < recipientIds.length; i += BATCH_SIZE) {
          const batch = recipientIds.slice(i, i + BATCH_SIZE);
          await Promise.all(
            batch.map(async (id) => {
              const recipient = recipientEmailMap.get(id);
              const ok = await emailService.sendMarketingEmail({
                to: recipient.email,
                customerName: recipient.name,
                subject: cleanSubject,
                bodyHtml: cleanBody,
                userId: recipient._id,
              });
              if (ok) sentCount += 1;
              else failedCount += 1;
            })
          );

          await EmailCampaign.updateOne(
            { campaignId },
            {
              $set: { sentCount, failedCount },
            }
          );

          if (i + BATCH_SIZE < recipientIds.length) {
            await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
          }
        }

        await EmailCampaign.updateOne(
          { campaignId },
          {
            status: 'completed',
            sentAt: new Date(),
            sentCount,
            failedCount,
          }
        );
      } catch (error) {
        console.error('Campaign background send failed:', error.message);
        await EmailCampaign.updateOne(
          { campaignId },
          { status: 'failed', failedCount }
        ).catch(() => {});
      }
    });

    res.json({
      success: true,
      message: `Campaign queued for ${recipients.length} recipient(s)`,
      data: {
        campaignId,
        recipientCount: recipients.length,
        status: 'queued',
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getCampaignHistory = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);
    const skip = (page - 1) * limit;

    // The page and the total are independent reads, so they are issued together
    // instead of one after the other.
    const [campaigns, total] = await Promise.all([
      EmailCampaign.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('createdBy', 'name email')
        .select('-bodyHtml')
        .lean(),
      EmailCampaign.countDocuments(),
    ]);

    res.json({
      success: true,
      data: campaigns,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};