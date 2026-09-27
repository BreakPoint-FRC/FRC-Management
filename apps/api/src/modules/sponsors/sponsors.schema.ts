import { z } from "zod";
import {
  paginationSchema,
  positiveDecimalStringSchema,
  sponsorshipStatusSchema,
} from "@breakpoint/types";

// z.string().url() only checks that the value parses as a URL -- the WHATWG
// URL spec accepts "javascript:..." as a perfectly well-formed one, and this
// value is later rendered as a real <a href> on the sponsors page. Restricting
// the scheme here is what stops a sponsor record from carrying a link that
// runs script in another user's browser when they click it.
const websiteSchema = z
  .string()
  .max(300)
  .refine(
    (value) => {
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: "Geçerli bir http(s) adresi girin" }
  );

const organizationFields = z.object({
  name: z.string().min(1, "Firma adı gerekli").max(160),
  website: websiteSchema.nullish(),
  email: z.string().email("Geçerli bir e-posta adresi girin").max(160).nullish(),
  phone: z.string().max(40).nullish(),
  notes: z.string().max(2000).nullish(),
});

export const createOrganizationSchema = organizationFields;
export const updateOrganizationSchema = organizationFields.partial();

// A company is separate from its relationship with the team, so the same firm
// can be a candidate one season and a sponsor the next without either record
// overwriting the other.
const sponsorshipFields = z.object({
  organizationId: z.string().min(1),
  seasonId: z.string().min(1).optional(),
  status: sponsorshipStatusSchema.default("CANDIDATE"),
  amount: positiveDecimalStringSchema.nullish(),
  assignedToId: z.string().min(1).nullish(),
  notes: z.string().max(2000).nullish(),
});

export const createSponsorshipSchema = sponsorshipFields;
export const updateSponsorshipSchema = sponsorshipFields
  .omit({ organizationId: true, seasonId: true })
  .partial();

export const listOrganizationsQuerySchema = paginationSchema.extend({
  search: z.string().trim().min(1).max(160).optional(),
});

export const listSponsorshipsQuerySchema = paginationSchema.extend({
  seasonId: z.string().optional(),
  status: sponsorshipStatusSchema.optional(),
  assignedToId: z.string().optional(),
  open: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .default(false),
});

// "Finansa isle": the only fields a caller gets to choose for the
// FinanceTransaction this creates. type, category, groupId, teamId, seasonId,
// createdById and sponsorshipId are all set server-side -- see
// sponsors.service.ts#convertToFinanceTransaction.
export const convertSponsorshipToFinanceSchema = z.object({
  amount: positiveDecimalStringSchema,
  transactionDate: z.coerce.date(),
  description: z.string().max(2000).nullish(),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type CreateSponsorshipInput = z.infer<typeof createSponsorshipSchema>;
export type UpdateSponsorshipInput = z.infer<typeof updateSponsorshipSchema>;
export type ListOrganizationsQuery = z.infer<typeof listOrganizationsQuerySchema>;
export type ListSponsorshipsQuery = z.infer<typeof listSponsorshipsQuerySchema>;
export type ConvertSponsorshipToFinanceInput = z.infer<typeof convertSponsorshipToFinanceSchema>;
