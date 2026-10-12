import { z } from "zod";

/**
 * Deterministic screening of untrusted product text (titles, brands, merchants,
 * categories and descriptions from Channel3 or the Demo Catalog) for prompt-
 * injection indicators. Pure: no network, no model, no clock.
 *
 * Text is normalized with NFKC and invisible characters are removed before any
 * pattern is matched, so hidden or look-alike characters cannot split a phrase.
 * Benign marketing copy ("Ignore the noise with ANC", "Free shipping") must not
 * match; only text that addresses an AI agent or tries to change purchase,
 * payment or approval facts does.
 */

export const CONTENT_RISKS = ["none", "suspicious", "malicious"] as const;
export const ContentRiskSchema = z.enum(CONTENT_RISKS);
export type ContentRisk = z.infer<typeof ContentRiskSchema>;

/** Stable signal codes. Append only: stored audit data and tests rely on these names. */
export const CONTENT_SIGNAL_CODES = [
  "AI_DIRECTED_TEXT",
  "INSTRUCTION_OVERRIDE",
  "ROLE_IMPERSONATION",
  "QUANTITY_MANIPULATION",
  "PRICE_MANIPULATION",
  "PAYEE_MANIPULATION",
  "SHIPPING_MANIPULATION",
  "BUDGET_MANIPULATION",
  "APPROVAL_BYPASS",
  "HIDDEN_CHARACTERS",
  "CONTROL_CHARACTERS",
  "SCRIPT_PAYLOAD",
  "MARKUP_PAYLOAD",
  "MARKDOWN_LINK",
  "EXCESSIVE_LENGTH",
] as const;

export type ContentSignalCode = (typeof CONTENT_SIGNAL_CODES)[number];

export interface ContentScreenResult {
  readonly risk: ContentRisk;
  /** Unique signal codes in declaration order. */
  readonly signals: readonly ContentSignalCode[];
  /** Field names that produced at least one signal, in input order. */
  readonly fields: readonly string[];
}

export type ScreenableValue = string | null | undefined | readonly (string | null | undefined)[];

/** Untrusted text fields keyed by name (title, brand, merchant, category, description, ...). */
export type ScreenableContent = Readonly<Record<string, ScreenableValue>>;

// Zero-width, word-joiner, invisible separators, BOM, Mongolian vowel separator,
// soft hyphen and the Hangul/Braille fillers commonly used to hide text.
const ZERO_WIDTH = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\u206A-\u206F\uFEFF\u3164\u2800]/gu;
const BIDI = /[\u061C\u202A-\u202E\u2066-\u2069]/gu;
// Unicode tag characters can smuggle invisible ASCII ("ASCII smuggling").
const TAGS = /[\u{E0000}-\u{E007F}]/gu;
const VARIATION_SELECTORS = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
// C0/C1 controls other than tab, line feed and carriage return.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

function hasMatch(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

/**
 * Removes invisible and control characters and applies NFKC. Line breaks and
 * tabs become single spaces. Safe for display and for model input.
 */
export function stripInvisibleCharacters(value: string): string {
  return value
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(BIDI, "")
    .replace(TAGS, "")
    .replace(VARIATION_SELECTORS, "")
    .replace(CONTROL, " ")
    .replace(/[\t\r\n\u2028\u2029]+/gu, " ")
    .replace(/ {2,}/gu, " ")
    .trim();
}

function decodeTagCharacters(value: string): string {
  let decoded = "";
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    if (point >= 0xe0020 && point <= 0xe007e) decoded += String.fromCodePoint(point - 0xe0000);
  }
  return decoded;
}

/** Lower-cased matching variants: hidden characters removed, and replaced with spaces. */
function matchingVariants(value: string): string[] {
  const nfkc = value.normalize("NFKC");
  const smuggled = decodeTagCharacters(nfkc);
  const prepare = (text: string) =>
    text
      .replace(CONTROL, " ")
      .replace(/[\u2018\u2019\u02BC\u2032]/gu, "'")
      .replace(/[\u201C\u201D\u2033]/gu, '"')
      .replace(/[\u2010-\u2015\u2212]/gu, "-")
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase("en-US");
  const removed = prepare(
    nfkc
      .replace(ZERO_WIDTH, "")
      .replace(BIDI, "")
      .replace(TAGS, "")
      .replace(VARIATION_SELECTORS, ""),
  );
  const spaced = prepare(
    nfkc
      .replace(ZERO_WIDTH, " ")
      .replace(BIDI, " ")
      .replace(TAGS, " ")
      .replace(VARIATION_SELECTORS, ""),
  );
  const variants = [removed];
  if (spaced !== removed) variants.push(spaced);
  if (smuggled.trim()) variants.push(prepare(smuggled));
  return variants;
}

const AI_TARGET = String.raw`(?:ai|a\.i\.|llms?|gpt|chatgpt|ai assistants?|ai agents?|assistants?|agents?)`;

/** Negated phrasing ("never ignore", "won't exceed") is advice to a person, not an instruction. */
const NOT_NEGATED = String.raw`(?<!\b(?:not|never|dont|don't|won't|wont|cannot|can't)\s)`;

/** Text that addresses an AI system rather than a human shopper. */
const AI_DIRECTED: readonly RegExp[] = [
  /\bas an? (?:ai|a\.i\.|ai language model|language model|llm|ai assistant)\b/u,
  /\byou are now (?:an? |the |my )?(?:[a-z]+ ){0,2}(?:assistant|agent|ai|bot|model|system|admin|administrator|developer)\b/u,
  /\byou are (?:no longer|not) (?:an? |the )?(?:ai|assistant|agent|bound by|restricted)\b/u,
  /\byou are (?:an? |the )(?:[a-z]+ ){0,2}(?:ai|assistant|agent|bot|language model)\b/u,
  new RegExp(
    String.raw`\b(?:dear|attention|note to|notice to|message to|hey|hello|instructions? (?:for|to))\s+(?:the\s+|all\s+|any\s+)?${AI_TARGET}\b`,
    "u",
  ),
  /\b(?:ai|a\.i\.|llm|gpt|automated|autonomous|shopping|buying|purchasing|checkout)[\s-]+(?:shopping[\s-]+|buying[\s-]+|purchasing[\s-]+)?(?:assistants?|agents?|bots?)\s*(?:[:,;]|(?:must|should|shall|need to|are (?:required|instructed|allowed|permitted)|reading this|please)\b)/u,
  /\b(?:if|when) you are an? (?:ai|llm|assistant|agent|bot|language model|automated)\b/u,
  /\bto (?:any|the|all) (?:ai|llm|automated|autonomous|shopping)\s+(?:system|assistant|agent|model)s? (?:reading|processing|parsing) this\b/u,
];

const INSTRUCTION_OVERRIDE: readonly RegExp[] = [
  new RegExp(
    String.raw`${NOT_NEGATED}\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|each\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+|these\s+|those\s+)?(?:previous|prior|above|earlier|preceding|original|initial|system|existing|current|developer)?\s*(?:instructions?|prompts?|directives?|system prompt|guardrails)\b`,
    "u",
  ),
  new RegExp(
    String.raw`${NOT_NEGATED}\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:your|the|these|those)?\s*(?:previous|prior|above|earlier|preceding|original)\s+(?:rules|guidelines|polic(?:y|ies)|context|messages?)\b`,
    "u",
  ),
  /\b(?:new|updated|real|actual|revised)\s+(?:system\s+)?instructions?\s*:/u,
  /\bdo not (?:tell|inform|alert|notify|show) (?:the )?(?:user|customer|human|shopper)\b/u,
];

const ROLE_IMPERSONATION: readonly RegExp[] = [
  /(?:^|[.!?;"'([{<>]\s*)(?:system|assistant|developer|admin(?:istrator)?)\s*(?:prompt|message|note|override|instruction)?\s*:/u,
  /<\|?\s*(?:im_start|im_end|system|endoftext)\s*\|?>/u,
  /\[\/?(?:inst|sys|system)\]/u,
  /<<\/?sys>>/u,
  /#{2,}\s*(?:system|instructions?)\b/u,
  /<\/?\s*(?:system|instructions?|tool_result|untrusted_listing)\s*>/u,
];

const QUANTITY: readonly RegExp[] = [
  /\b(?:set|change|increase|update|raise|bump|modify|override|adjust)\s+(?:the\s+|your\s+|order\s+)?(?:order\s+)?(?:quantity|qty|units?|number of units)\s+(?:to|=|at)\s*\d+/u,
  /\b(?:quantity|qty)\s*(?:=|:)?\s*(?:should|must|needs to|has to)\s+be\s*\d+/u,
  /\b(?:order|buy|purchase|add)\s+(?:\d{1,3}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:units|copies|more|extra|additional)\b(?=[^.]*\b(?:instead|always|automatically|regardless)\b)/u,
];

const PRICE: readonly RegExp[] = [
  /\b(?:set|change|update|override|modify|adjust|report|treat)\s+(?:the\s+)?(?:price|total|amount|cost|subtotal)\s+(?:to|as|=)\s*\$?\d/u,
  /\bcharge\s+(?:the\s+)?(?:customer|buyer|shopper)s?(?:'s?)?\s+(?:card|account|paypal|\$|\d)/u,
  /\b(?:the\s+)?(?:real|actual|true)\s+price\s+is\b/u,
];

const PAYEE: readonly RegExp[] = [
  /\b(?:send|transfer|wire|route|redirect|forward)\s+(?:the\s+|all\s+)?(?:payment|money|funds|proceeds|amount)\s+(?:to|into|via)\b/u,
  /\b(?:change|update|set|replace|switch)\s+(?:the\s+)?(?:payee|recipient|beneficiary|merchant account|seller account|paypal (?:account|email|address)|payment (?:account|destination|recipient))\b/u,
  /\bpay(?:ment)?\s+(?:to|via)\s+[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/u,
];

const SHIPPING: readonly RegExp[] = [
  /\b(?:change|update|set|replace|use|redirect|override)\s+(?:the\s+|their\s+|the customer's\s+)?(?:shipping|delivery|billing|mailing)\s+address\b/u,
  /\b(?:ship|deliver|send)\s+(?:it|this|the (?:order|item|items|package|parcel)|orders|everything)\s+to\s+(?:a\s+)?(?:new|different|this|the following|another)\b/u,
];

const BUDGET: readonly RegExp[] = [
  new RegExp(
    String.raw`${NOT_NEGATED}\b(?:ignore|exceed|raise|increase|override|bypass|disregard|lift|remove)\s+(?:the\s+)?(?:customer's\s+|customers'\s+|user's\s+|buyer's\s+|shopper's\s+|your\s+|their\s+|any\s+|all\s+)?(?:budget|spending (?:limit|cap)|price cap|price limit|mandate|spend(?:ing)? limit|purchase limit|transaction limit)s?\b`,
    "u",
  ),
  /\b(?:budget|spending limit|mandate)\s+(?:does not|doesn't|no longer)\s+appl(?:y|ies)\b/u,
];

const APPROVAL_BYPASS: readonly RegExp[] = [
  new RegExp(
    String.raw`${NOT_NEGATED}\b(?:skip|bypass|ignore|disable|avoid|omit|circumvent|turn off|suppress)\s+(?:the\s+|any\s+|all\s+|your\s+)?(?:(?:human|user|customer|manual|additional|further|payment|purchase|policy|security)\s+)?(?:verification|approval|confirmation|review|authori[sz]ation|2fa|mfa|security checks?|consent|policy checks?|agentguard)(?!\s+(?:sounds?|tones?|beeps?|voice|lights?|leds?|chimes?))(?:\s+(?:step|steps|screen|process|prompt))?\b`,
    "u",
  ),
  /\b(?:no need (?:for|to)|don't|dont|do not|never)\s+(?:ask|wait|check|request)\s*(?:for\s+)?(?:the\s+)?(?:user's\s+|customer's\s+|human\s+)?(?:approval|confirmation|permission|consent|verification)\b/u,
  /\b(?:already approved by the (?:user|customer|buyer)|auto-?approve)\b/u,
  /\bwithout\s+(?:asking|waiting for|requiring)\s+(?:the\s+)?(?:user|customer|human|buyer|approval|confirmation|permission)\b/u,
];

const SCRIPT_PAYLOAD: readonly RegExp[] = [
  /<\/?(?:script|iframe|object|embed|frameset|frame|applet)\b/u,
  /\bjavascript\s*:/u,
  /\bvbscript\s*:/u,
  /\bdata\s*:\s*text\/html\b/u,
  /<[a-z][^>]{0,200}\son[a-z]{3,20}\s*=/u,
];

const MARKUP_PAYLOAD: readonly RegExp[] = [
  /<\/?(?:form|input|button|meta|link|style|svg|img|base|textarea|select|details|template)\b/u,
];

const MARKDOWN_LINK: readonly RegExp[] = [/!?\[[^\]\n]{0,200}\]\(\s*[^)\s]+[^)]*\)/u];

const FIELD_LIMITS: Readonly<Record<string, number>> = {
  title: 300,
  brand: 120,
  merchant: 160,
  category: 160,
  categoryPath: 255,
  condition: 40,
  description: 5_000,
};
const DEFAULT_FIELD_LIMIT = 1_000;

const ACTION_SIGNALS: ReadonlySet<ContentSignalCode> = new Set([
  "QUANTITY_MANIPULATION",
  "PRICE_MANIPULATION",
  "PAYEE_MANIPULATION",
  "SHIPPING_MANIPULATION",
  "BUDGET_MANIPULATION",
  "APPROVAL_BYPASS",
]);

const PATTERN_SIGNALS: readonly (readonly [ContentSignalCode, readonly RegExp[]])[] = [
  ["AI_DIRECTED_TEXT", AI_DIRECTED],
  ["INSTRUCTION_OVERRIDE", INSTRUCTION_OVERRIDE],
  ["ROLE_IMPERSONATION", ROLE_IMPERSONATION],
  ["QUANTITY_MANIPULATION", QUANTITY],
  ["PRICE_MANIPULATION", PRICE],
  ["PAYEE_MANIPULATION", PAYEE],
  ["SHIPPING_MANIPULATION", SHIPPING],
  ["BUDGET_MANIPULATION", BUDGET],
  ["APPROVAL_BYPASS", APPROVAL_BYPASS],
  ["SCRIPT_PAYLOAD", SCRIPT_PAYLOAD],
  ["MARKUP_PAYLOAD", MARKUP_PAYLOAD],
  ["MARKDOWN_LINK", MARKDOWN_LINK],
];

function valuesOf(value: ScreenableValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

/** Signals found in one untrusted text value. */
export function contentSignals(value: string, field = "text"): ContentSignalCode[] {
  const found = new Set<ContentSignalCode>();
  if (hasMatch(ZERO_WIDTH, value) || hasMatch(BIDI, value) || hasMatch(TAGS, value)) {
    found.add("HIDDEN_CHARACTERS");
  }
  if (hasMatch(CONTROL, value)) found.add("CONTROL_CHARACTERS");
  // "catalogDescription" or "sellerTitle" use the limit of their base field.
  const base = Object.keys(FIELD_LIMITS).find(
    (name) => field === name || field.toLowerCase().endsWith(name.toLowerCase()),
  );
  const limit = base ? (FIELD_LIMITS[base] ?? DEFAULT_FIELD_LIMIT) : DEFAULT_FIELD_LIMIT;
  if (value.length > limit) found.add("EXCESSIVE_LENGTH");
  // Bound the work per field; longer text is already flagged above.
  const variants = matchingVariants(value.slice(0, 20_000));
  for (const [code, patterns] of PATTERN_SIGNALS) {
    if (variants.some((variant) => patterns.some((pattern) => hasMatch(pattern, variant)))) {
      found.add(code);
    }
  }
  return CONTENT_SIGNAL_CODES.filter((code) => found.has(code));
}

/** Risk for a set of signals. Malicious means the listing clearly tries to steer an agent. */
export function contentRiskFor(signals: readonly ContentSignalCode[]): ContentRisk {
  if (!signals.length) return "none";
  const has = (code: ContentSignalCode) => signals.includes(code);
  const actions = signals.filter((code) => ACTION_SIGNALS.has(code)).length;
  const addressed = has("AI_DIRECTED_TEXT") || has("ROLE_IMPERSONATION");
  if (
    has("INSTRUCTION_OVERRIDE") ||
    has("SCRIPT_PAYLOAD") ||
    (addressed && actions > 0) ||
    (has("ROLE_IMPERSONATION") && has("AI_DIRECTED_TEXT")) ||
    actions >= 2
  ) {
    return "malicious";
  }
  return "suspicious";
}

/** Screens every untrusted field of one listing. */
export function screenUntrustedContent(content: ScreenableContent): ContentScreenResult {
  const found = new Set<ContentSignalCode>();
  const fields: string[] = [];
  for (const [field, raw] of Object.entries(content)) {
    let flagged = false;
    for (const value of valuesOf(raw)) {
      const signals = contentSignals(value, field);
      if (signals.length) flagged = true;
      for (const signal of signals) found.add(signal);
    }
    if (flagged) fields.push(field);
  }
  const signals = CONTENT_SIGNAL_CODES.filter((code) => found.has(code));
  return Object.freeze({
    risk: contentRiskFor(signals),
    signals: Object.freeze(signals),
    fields: Object.freeze(fields),
  });
}

/** Plain-language description of a screening result for users and logs. */
export function contentRiskMessage(risk: ContentRisk): string | null {
  if (risk === "malicious") return "Listing contains instructions aimed at AI agents";
  if (risk === "suspicious") return "Listing contains instruction-like or hidden text";
  return null;
}
