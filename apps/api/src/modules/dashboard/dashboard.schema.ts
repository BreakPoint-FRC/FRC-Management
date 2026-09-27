import { z } from "zod";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Convert the browser's local calendar day into the UTC-midnight shape used
 * for date-only database columns. This preserves the calendar numbers; it is
 * deliberately not a timezone conversion.
 */
const dashboardDaySchema = z
  .string()
  .regex(DATE_ONLY, "Tarih YYYY-MM-DD biçiminde olmalı")
  .transform((key, ctx) => {
    const date = new Date(`${key}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== key) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Geçerli bir takvim tarihi gerekli" });
      return z.NEVER;
    }
    return date;
  });

export const dashboardQuerySchema = z.object({ today: dashboardDaySchema }).strict();

