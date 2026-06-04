# Cost Tracking Module

## Overview

The Cost Tracking Module provides an enterprise-grace solution for tracking LLM token consumption and monetary costs across all Multi-Agent sessions.
It is built strictly following Domain-Driven Design (DDD) principles to ensure floating-point accuracy, complete separation of concerns, and aesthetic CLI feedback.

## Architecture (DDD)

### 1. Domain Layer
- **`TokenUsage` (Value Object)**: Ensures  that token counts are never negative. It provides the pure logic to accumulate tokens (prompt/candidate).
- **`Money` (Value Object)**: Wraps all currency-related math. It completely isolates JavaScript floating-point rounding bugs by tracking up to 6 decimals, and exposes aesthetic formats like `$0.007 USD`.
- **`PricingRegistry` (Interface)**: The pure contract to retrieve an LLM model's dollar-cost per million tokens.

### 2. Infrastructure Layer
- **`LlmPricingConfig`**: An implementation of `PricingRegistry` that hydrates the pricing values dynamically from the visual `llm-pricing.json` file in the project's root directory.

### 3. Application Layer
- **`CostTrackerService`**: The coordinator. Given an LLM model name and a precise `TokenUsage` VO, it pulls the current price and performs the "Million-tokens" division safely, returning a `Money` VO.

### 4. Graph & State Integration
LangGraph seamlessly accumulates state variables via annotation reducers.
- `accumulatedTokens`
- `accumulatedCost`

Inside each agent node (Researcher, Coder, Supervisor), the `usaage_metadata` extracted from Google Vertex AI is instantly converted and formatted, giving robust metrics.

### 5. Presentation Layer
CLI beauty is handled by `OraTaskIndicator`. Upon completion of any task (e.g. `task.succeed("...")`), it formats the token and cost logs using elegant Chalk colors for a stunning "Wow" effect.

## How to Configure Pricing
To adjust model prices, simply open `llm-pricing.json` in the project root:

```json
{
  "gemini-2.0-flash-lite-001": {
    "inputMillion": 0.075,
    "outputMillion": 0.30
  },
  "gemini-3.1-pro-preview": {
    "inputMillion": 2.00,
    "outputMillion": 12.00
  }
}
```
All system components will automatically read this data dynamically.
