import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_BASE_URL,
  OpenAIConfigurationError,
  loadOpenAIConfig,
  parseOpenAIConfig,
} from "../src/index.js";

describe("OpenAI server configuration", () => {
  it("requires the API key and model from trusted environment values", () => {
    expect(() => loadOpenAIConfig({ OPENAI_MODEL: "model" })).toThrowError(
      expect.objectContaining({ code: "MISSING_API_KEY" }),
    );
    expect(() => loadOpenAIConfig({ OPENAI_API_KEY: "sk-test" })).toThrowError(
      expect.objectContaining({ code: "MISSING_MODEL" }),
    );
  });

  it("uses the official base URL by default and keeps the response mode explicit", () => {
    const config = loadOpenAIConfig({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "model" });

    expect(config.baseURL).toBe(DEFAULT_OPENAI_BASE_URL);
    expect(config.responseMode).toBe("json_schema");
    expect(config.maxRetries).toBe(1);
    expect(config.maxOutputTokens).toBe(2_048);
    expect(config.reasoningEffort).toBeNull();
  });

  it("accepts a trusted OpenAI-compatible base URL without treating it as a prompt value", () => {
    const config = loadOpenAIConfig({
      OPENAI_API_KEY: "gateway-key",
      OPENAI_MODEL: "gateway-model",
      OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
      OPENAI_RESPONSE_MODE: "json_object",
    });

    expect(config.baseURL).toBe("http://127.0.0.1:8080/v1");
    expect(config.responseMode).toBe("json_object");
  });

  it("rejects URLs containing credentials and unsupported response modes", () => {
    expect(() =>
      parseOpenAIConfig({
        apiKey: "sk-test",
        model: "model",
        baseURL: "https://user:pass@example.com/v1",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_BASE_URL" }));
    expect(() =>
      parseOpenAIConfig({ apiKey: "sk-test", model: "model", responseMode: "freeform" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE_MODE" }));
  });

  it("bounds output budgets and reasoning values", () => {
    expect(() =>
      parseOpenAIConfig({ apiKey: "sk-test", model: "model", maxOutputTokens: 127 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OUTPUT_TOKEN_BUDGET" }));
    expect(() =>
      parseOpenAIConfig({ apiKey: "sk-test", model: "model", maxOutputTokens: 8_193 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OUTPUT_TOKEN_BUDGET" }));
    expect(() =>
      parseOpenAIConfig({ apiKey: "sk-test", model: "model", reasoningEffort: "max" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REASONING_EFFORT" }));
    expect(
      parseOpenAIConfig({
        apiKey: "sk-test",
        model: "model",
        maxOutputTokens: 512,
        reasoningEffort: "low",
      }),
    ).toMatchObject({ maxOutputTokens: 512, reasoningEffort: "low" });
  });

  it("never includes secret values in configuration errors", () => {
    try {
      parseOpenAIConfig({ apiKey: "sk-secret-value", model: "" });
      throw new Error("expected configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAIConfigurationError);
      expect(String(error)).not.toContain("sk-secret-value");
    }
  });
});
