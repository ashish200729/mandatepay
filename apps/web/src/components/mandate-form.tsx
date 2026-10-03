"use client";

import { useId } from "react";
import {
  formatUsdMinor,
  fromUtcIso,
  parseQuantity,
  parseUsdDecimal,
  toUtcIso,
} from "@/lib/mandates/money";
import {
  PRODUCT_CONDITIONS,
  type CanonicalMandate,
  type MandateFormState,
  type ProductCondition,
} from "@/lib/mandates/types";

const fieldClassName =
  "mt-2 h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60";

export const EMPTY_MANDATE_FORM: MandateFormState = {
  title: "",
  productIntent: "",
  allowedBrands: "",
  blockedBrands: "",
  allowedCategories: "",
  blockedCategories: "",
  allowedConditions: ["NEW"],
  autoSpendLimit: "0.00",
  transactionLimit: "",
  dailyLimit: "",
  weeklyLimit: "",
  monthlyLimit: "",
  quantityLimit: "1",
  allowedMerchants: "",
  blockedMerchants: "",
  newMerchantRequiresApproval: true,
  startsAt: "",
  expiresAt: "",
};

function joinValues(values: string[]) {
  return values.join(", ");
}

function splitValues(value: string) {
  const seen = new Set<string>();
  return value
    .split(/[,\n]/u)
    .map((item) => item.trim())
    .filter((item) => {
      const key = item.toLocaleLowerCase("en-US");
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function canonicalToForm(mandate: CanonicalMandate): MandateFormState {
  return {
    title: mandate.title,
    productIntent: mandate.productIntent,
    allowedBrands: joinValues(mandate.allowedBrands),
    blockedBrands: joinValues(mandate.blockedBrands),
    allowedCategories: joinValues(mandate.allowedCategories),
    blockedCategories: joinValues(mandate.blockedCategories),
    allowedConditions: mandate.allowedConditions,
    autoSpendLimit: formatUsdMinor(mandate.autoSpendLimit),
    transactionLimit: formatUsdMinor(mandate.transactionLimit),
    dailyLimit: mandate.dailyLimit === undefined ? "" : formatUsdMinor(mandate.dailyLimit),
    weeklyLimit: mandate.weeklyLimit === undefined ? "" : formatUsdMinor(mandate.weeklyLimit),
    monthlyLimit: mandate.monthlyLimit === undefined ? "" : formatUsdMinor(mandate.monthlyLimit),
    quantityLimit: String(mandate.quantityLimit),
    allowedMerchants: joinValues(mandate.allowedMerchants),
    blockedMerchants: joinValues(mandate.blockedMerchants),
    newMerchantRequiresApproval: mandate.newMerchantRequiresApproval,
    startsAt: fromUtcIso(mandate.startsAt),
    expiresAt: fromUtcIso(mandate.expiresAt),
  };
}

function optionalMoney(value: string) {
  if (!value.trim()) return undefined;
  const amount = parseUsdDecimal(value);
  if (amount <= 0) throw new Error("Optional spending limits must be greater than zero.");
  return amount;
}

function assertNoOverlap(allowed: string[], blocked: string[], label: string) {
  const blockedValues = new Set(blocked.map((item) => item.toLocaleLowerCase("en-US")));
  if (allowed.some((item) => blockedValues.has(item.toLocaleLowerCase("en-US")))) {
    throw new Error(`Allowed and blocked ${label} values cannot overlap.`);
  }
}

export function formToCanonical(form: MandateFormState): CanonicalMandate {
  const title = form.title.trim();
  const productIntent = form.productIntent.trim();
  if (!title) throw new Error("Add a title for this mandate.");
  if (!productIntent) throw new Error("Describe what this mandate covers.");
  if (!form.allowedConditions.length) throw new Error("Choose at least one allowed condition.");

  const autoSpendLimit = parseUsdDecimal(form.autoSpendLimit);
  const transactionLimit = parseUsdDecimal(form.transactionLimit);
  if (autoSpendLimit > transactionLimit) {
    throw new Error("The automatic spending limit cannot exceed the maximum transaction amount.");
  }

  const allowedBrands = splitValues(form.allowedBrands);
  const blockedBrands = splitValues(form.blockedBrands);
  const allowedCategories = splitValues(form.allowedCategories);
  const blockedCategories = splitValues(form.blockedCategories);
  const allowedMerchants = splitValues(form.allowedMerchants);
  const blockedMerchants = splitValues(form.blockedMerchants);
  assertNoOverlap(allowedBrands, blockedBrands, "brand");
  assertNoOverlap(allowedCategories, blockedCategories, "category");
  assertNoOverlap(allowedMerchants, blockedMerchants, "merchant");

  const startsAt = toUtcIso(form.startsAt);
  const expiresAt = toUtcIso(form.expiresAt);
  if (startsAt && expiresAt && Date.parse(startsAt) >= Date.parse(expiresAt)) {
    throw new Error("Expiration must be after the start time.");
  }

  return {
    title,
    productIntent,
    currency: "USD",
    timezone: "UTC",
    allowedBrands,
    blockedBrands,
    allowedCategories,
    blockedCategories,
    allowedConditions: form.allowedConditions,
    autoSpendLimit,
    transactionLimit,
    dailyLimit: optionalMoney(form.dailyLimit),
    weeklyLimit: optionalMoney(form.weeklyLimit),
    monthlyLimit: optionalMoney(form.monthlyLimit),
    quantityLimit: parseQuantity(form.quantityLimit),
    allowedMerchants,
    blockedMerchants,
    newMerchantRequiresApproval: form.newMerchantRequiresApproval,
    startsAt,
    expiresAt,
  };
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-5 border-t border-border pt-7 first:border-t-0 first:pt-0 xl:grid-cols-[200px_minmax(0,1fr)]">
      <div>
        <h3 className="text-base font-medium">{title}</h3>
        {description ? (
          <p className="mt-2 max-w-[600px] text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  inputMode,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: "decimal" | "numeric" | "text";
  disabled?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block text-sm font-medium">
      {label}
      {hint ? <span className="ml-2 text-xs font-normal text-muted-foreground">{hint}</span> : null}
      <input
        id={id}
        className={fieldClassName}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        type={type}
        inputMode={inputMode}
        disabled={disabled}
      />
    </label>
  );
}

function ListField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block text-sm font-medium">
      {label}
      <input
        id={id}
        className={fieldClassName}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <span className="mt-2 block text-xs font-normal text-muted-foreground">
        Separate values with commas.
      </span>
    </label>
  );
}

export function MandateForm({
  value,
  onChange,
  disabled = false,
}: {
  value: MandateFormState;
  onChange: (next: MandateFormState) => void;
  disabled?: boolean;
}) {
  const update = <K extends keyof MandateFormState>(key: K, next: MandateFormState[K]) =>
    onChange({ ...value, [key]: next });

  const toggleCondition = (condition: ProductCondition) => {
    const conditions = value.allowedConditions.includes(condition)
      ? value.allowedConditions.filter((item) => item !== condition)
      : [...value.allowedConditions, condition];
    update("allowedConditions", conditions);
  };

  return (
    <div className="min-w-0 space-y-7 rounded-xl border border-border bg-card p-5 sm:p-7">
      <Section
        title="What this covers"
        description="Keep the intent concrete. The agent will use these words to find suitable products later."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Mandate title"
            value={value.title}
            onChange={(next) => update("title", next)}
            placeholder="Noise-cancelling headphones"
            disabled={disabled}
          />
          <TextField
            label="Product intent"
            value={value.productIntent}
            onChange={(next) => update("productIntent", next)}
            placeholder="Wireless noise-cancelling headphones"
            disabled={disabled}
          />
        </div>
      </Section>

      <Section
        title="Spending permission"
        description="The maximum is a hard ceiling. The automatic limit is the most the agent may spend without asking you."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Maximum transaction"
            value={value.transactionLimit}
            onChange={(next) => update("transactionLimit", next)}
            placeholder="180.00"
            inputMode="decimal"
            disabled={disabled}
            hint="USD"
          />
          <TextField
            label="Automatic spending"
            value={value.autoSpendLimit}
            onChange={(next) => update("autoSpendLimit", next)}
            placeholder="150.00"
            inputMode="decimal"
            disabled={disabled}
            hint="USD"
          />
          <TextField
            label="Quantity limit"
            value={value.quantityLimit}
            onChange={(next) => update("quantityLimit", next)}
            placeholder="1"
            inputMode="numeric"
            disabled={disabled}
          />
          <TextField
            label="Currency"
            value="USD"
            onChange={() => undefined}
            disabled
            hint="Fixed"
          />
        </div>
        <div className="mt-6">
          <p className="text-sm font-medium">Allowed condition</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {PRODUCT_CONDITIONS.map((condition) => {
              const checked = value.allowedConditions.includes(condition);
              return (
                <label
                  key={condition}
                  className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 text-sm transition-colors has-[:checked]:border-foreground has-[:checked]:bg-secondary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleCondition(condition)}
                    className="size-4 accent-primary"
                  />
                  {condition === "REFURBISHED"
                    ? "Refurbished"
                    : condition.charAt(0) + condition.slice(1).toLowerCase()}
                </label>
              );
            })}
          </div>
        </div>
      </Section>

      <Section
        title="Restrictions"
        description="Leave a list empty when it should not constrain the mandate."
      >
        <div className="grid gap-5 md:grid-cols-2">
          <ListField
            label="Allowed brands"
            value={value.allowedBrands}
            onChange={(next) => update("allowedBrands", next)}
            placeholder="Sony, Bose"
            disabled={disabled}
          />
          <ListField
            label="Blocked brands"
            value={value.blockedBrands}
            onChange={(next) => update("blockedBrands", next)}
            placeholder="Example: Unknown brand"
            disabled={disabled}
          />
          <ListField
            label="Allowed categories"
            value={value.allowedCategories}
            onChange={(next) => update("allowedCategories", next)}
            placeholder="Headphones"
            disabled={disabled}
          />
          <ListField
            label="Blocked categories"
            value={value.blockedCategories}
            onChange={(next) => update("blockedCategories", next)}
            placeholder="Example: Accessories"
            disabled={disabled}
          />
          <ListField
            label="Allowed merchants"
            value={value.allowedMerchants}
            onChange={(next) => update("allowedMerchants", next)}
            placeholder="Example: Demo Store"
            disabled={disabled}
          />
          <ListField
            label="Blocked merchants"
            value={value.blockedMerchants}
            onChange={(next) => update("blockedMerchants", next)}
            placeholder="Example: Unknown merchant"
            disabled={disabled}
          />
        </div>
        <label className="mt-5 flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border px-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
          <input
            type="checkbox"
            checked={value.newMerchantRequiresApproval}
            disabled={disabled}
            onChange={(event) => update("newMerchantRequiresApproval", event.currentTarget.checked)}
            className="size-4 accent-primary"
          />
          Ask before buying from a new merchant
        </label>
      </Section>

      <Section
        title="Spending windows"
        description="All dates and period limits use UTC. Empty optional periods remain unset."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Daily limit"
            value={value.dailyLimit}
            onChange={(next) => update("dailyLimit", next)}
            placeholder="Optional"
            inputMode="decimal"
            disabled={disabled}
            hint="USD"
          />
          <TextField
            label="Weekly limit"
            value={value.weeklyLimit}
            onChange={(next) => update("weeklyLimit", next)}
            placeholder="Optional"
            inputMode="decimal"
            disabled={disabled}
            hint="USD"
          />
          <TextField
            label="Monthly limit"
            value={value.monthlyLimit}
            onChange={(next) => update("monthlyLimit", next)}
            placeholder="Optional"
            inputMode="decimal"
            disabled={disabled}
            hint="USD"
          />
          <TextField
            label="Timezone"
            value="UTC"
            onChange={() => undefined}
            disabled
            hint="Fixed"
          />
        </div>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <TextField
            label="Starts at"
            value={value.startsAt}
            onChange={(next) => update("startsAt", next)}
            type="datetime-local"
            disabled={disabled}
            hint="UTC"
          />
          <TextField
            label="Expires at"
            value={value.expiresAt}
            onChange={(next) => update("expiresAt", next)}
            type="datetime-local"
            disabled={disabled}
            hint="UTC · server defaults to 24h when empty"
          />
        </div>
      </Section>
    </div>
  );
}
