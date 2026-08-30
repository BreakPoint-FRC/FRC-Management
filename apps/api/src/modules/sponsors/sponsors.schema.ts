import { z } from "zod";
import {
  paginationSchema,
  positiveDecimalStringSchema,
  sponsorshipStatusSchema,
} from "@breakpoint/types";

const organizationFields = z.object({
  name: z.string().min(1, "Firma adi gerekli").max(160),
  website: z.string().url("Gecerli bir adres girin").max(300).nullish(),
  email: z.string().email("Gecerli bir e-posta adresi girin").max(160).nullish(),
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

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type CreateSponsorshipInput = z.infer<typeof createSponsorshipSchema>;
export type UpdateSponsorshipInput = z.infer<typeof updateSponsorshipSchema>;
export type ListOrganizationsQuery = z.infer<typeof listOrganizationsQuerySchema>;
export type ListSponsorshipsQuery = z.infer<typeof listSponsorshipsQuerySchema>;
