import Stripe from "stripe";
import { getStripeConfig, isStripeConfigured } from "@/lib/env";

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (!isStripeConfigured()) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.");
  }
  if (!cached) {
    cached = new Stripe(getStripeConfig().secretKey, {
      apiVersion: "2025-02-24.acacia",
      typescript: true,
    });
  }
  return cached;
}

export { isStripeConfigured };
