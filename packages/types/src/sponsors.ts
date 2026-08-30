import { z } from "zod";

import { positiveDecimalStringSchema } from "./finance";

export const sponsorshipStatusSchema = z.enum([
  "CANDIDATE",
  "CONTACTED",
  "NEGOTIATING",
  "SPONSOR",
  "REJECTED",
  "INACTIVE",
]);

// The company itself, kept separate from any season. Its name, site and contact
// details do not change when the season does -- only the relationship does.
export const organizationSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  website: z.string().url("Gecerli bir adres girin").nullish(),
  email: z.string().email("Gecerli bir e-posta adresi girin").nullish(),
  phone: z.string().max(40).nullish(),
  notes: z.string().max(2000).nullish(),
});

// One company's relationship with the team for one season. This is what lets a
// firm be a candidate in 2026 and a sponsor in 2027 without rewriting history.
export const sponsorshipSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  seasonId: z.string(),
  status: sponsorshipStatusSchema,
  amount: positiveDecimalStringSchema.nullish(),
  assignedToId: z.string().nullish(),
  notes: z.string().max(2000).nullish(),
});

export const sponsorshipStatusLabels: Record<SponsorshipStatus, string> = {
  CANDIDATE: "Aday",
  CONTACTED: "Iletisime gecildi",
  NEGOTIATING: "Gorusuluyor",
  SPONSOR: "Sponsor",
  REJECTED: "Reddedildi",
  INACTIVE: "Pasif",
};

/** Statuses where the company is still worth chasing. */
export const OPEN_SPONSORSHIP_STATUSES: readonly SponsorshipStatus[] = [
  "CANDIDATE",
  "CONTACTED",
  "NEGOTIATING",
];

export type Organization = z.infer<typeof organizationSchema>;
export type Sponsorship = z.infer<typeof sponsorshipSchema>;
export type SponsorshipStatus = z.infer<typeof sponsorshipStatusSchema>;
