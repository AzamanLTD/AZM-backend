// services/validation/businessSchemas.js
const logger = require('../../src/config/logger');
const { z } = require('zod');

const BUSINESS_CATEGORIES = [
  'FREELANCE_SERVICES', 'RETAIL', 'FOOD_BEVERAGE', 'TECHNOLOGY', 'REAL_ESTATE',
  'EDUCATION', 'HEALTH_WELLNESS', 'ENTERTAINMENT', 'LOGISTICS',
  'FINANCIAL_SERVICES', 'OTHER',
];

const businessName = z
  .string({ required_error: 'businessName is required.' })
  .trim()
  .min(2, 'businessName must be 2–100 chars.')
  .max(100, 'businessName must be 2–100 chars.');

const description = z.string().max(500, 'description must be max 500 chars.').optional();
const freeString = z.string().optional();

const businessRegisterSchema = z.object({
  businessName,
  category: z.enum(BUSINESS_CATEGORIES).optional(),
  description,
  website: freeString,
  logoUrl: freeString,
  phoneNumber: freeString,
  contactEmail: freeString,
  address: freeString,
  country: freeString,
});

const businessUpdateSchema = z.object({
  businessName: businessName.optional(),
  category: freeString,
  description,
  website: freeString,
  logoUrl: freeString,
  phoneNumber: freeString,
  contactEmail: freeString,
  address: freeString,
  country: freeString,
  offerEscrowProtection: z.boolean().optional(),
});

module.exports = {
  BUSINESS_CATEGORIES,
  businessRegisterSchema,
  businessUpdateSchema,
};
