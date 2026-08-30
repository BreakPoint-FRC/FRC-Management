import { z } from "zod";
import { emailSchema, passwordSchema } from "@breakpoint/types";

export const loginSchema = z.object({
  email: emailSchema,
  // Not passwordSchema: the length rule belongs on the password someone is
  // *setting*, not the one they are typing to get in. Applying it here would
  // lock out anyone whose password predates the rule and would leak the rule
  // to an attacker one failed login at a time.
  password: z.string().min(1, "Sifre gerekli"),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Mevcut sifre gerekli"),
    newPassword: passwordSchema,
  })
  .refine((input) => input.currentPassword !== input.newPassword, {
    message: "Yeni sifre eskisiyle ayni olamaz",
    path: ["newPassword"],
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
