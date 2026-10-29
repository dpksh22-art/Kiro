# ADR 0003: Owned provider-neutral gateway with direct HTTP adapters

- Status: accepted
- Date: 2026-10-29

## Context

Providers expose materially different message, streaming, tool, schema, usage, and discovery semantics. Making an OpenAI request type the domain model would silently lose capabilities. Running LiteLLM adds a Python service and still requires application policy and metadata validation.

## Decision

Own a small canonical request/event contract and implement adapters for OpenAI Responses/Chat, Anthropic Messages, Gemini GenerateContent, strict OpenAI-compatible providers, and Ollama. Preserve provider extensions, reject unsupported required capabilities, and store evidence with capability claims. Keep a LiteLLM adapter boundary as a later deployment choice rather than making it a launch dependency.

## Consequences

The initial adapter surface remains auditable and deploys in one process. Every adapter must pass the same contract suite. Provider model names, prices, and limits are discovered or configured with evidence; unknown values stay unknown.
