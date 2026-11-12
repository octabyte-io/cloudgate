# Calling an AI model from your own stack

An **AI model** is an Application that serves one model through an inference runtime. You add it from an Environment's Services tab and deploy it like any Application, and then other things call it: a chat front end, a vector store or ingestion job that needs embeddings, or one of your own Services. This page walks through wiring one of those callers to it.

Every call reaches the AI model through the **gateway**, an OpenAI-compatible proxy inside Cloudgate. It is the only way in. An AI model has no Domain and no published port, and no other Service can reach it on the network. The gateway checks the caller's key and holds the call to the one model the AI model serves. It also counts the tokens the call spends. A caller authenticates with the key of a **caller Agent**: an Agent on the **Caller** role, granted the AI models it may call, and nothing else.

**Give each calling Service its own caller Agent: one caller Agent per calling Service.** Token spend is broken down by the Agent that called. One key shared across your stack makes every Service's spend one line. Separate Agents also let you suspend or revoke one caller without cutting off the others.

---

## Before you start

**A console domain is best for long streams.** The gateway is served at `/ai` on the console's own address. With a console domain, its own Traefik routers beside the console's take the call straight to the gateway, and with HTTPS on the domain the endpoint is HTTPS too. On an install reached by IP address and port alone, the console forwards `/ai` to the gateway itself, which works for every call but cuts a stream that goes quiet for four minutes. Assign a console domain in Instance settings for that.

**The AI model has to be deployed.** Adding it does not deploy it. Until its first Deployment starts, and while it is stopped, the gateway answers 503. The first Deployment pulls the model. Calls made while it is still pulling are passed on and fail at the runtime, so wait until the AI model reads as ready.

## 1. Add the AI model

On the Environment's Services tab, choose **Add an AI model**. Name it, pick the Server it runs on and how many GPUs it reserves, and give the **Model** in the runtime's own naming (for Ollama, a name such as `llama3.2:3b` or `nomic-embed-text`). Then deploy it.

One AI model serves one model. A chat front end that also embeds documents needs two AI models: one serving a chat model, one serving an embedding model.

## 2. Create a caller Agent, one per calling Service

Open the AI model's **Model** tab. The **Connect a client** card shows its **Endpoint**:

```
https://<console domain>/ai/<AI model id>/v1
```

That is the base URL an OpenAI client is given. The card also shows a JavaScript snippet for the OpenAI SDK with this endpoint and model filled in. The snippet never holds a key.

Choose **Create a caller Agent**. The button is shown only to people who may add members to the Organization. It opens the Agents dialog already set to the **Caller** role, with a grant on this AI model. The grant includes the AI model's Environment and Project, because a grant on a Service alone does not reach it. Name the Agent after the Service that will use it, such as `support-chat`. Its key is shown once, in that dialog. Copy it then.

A Caller Agent can call the AI models it is granted, and nothing else. It cannot read, deploy or change anything, and it gets no tools over MCP. Its key is refused on the REST API, as every agent key is.

**Agents that can call it**, under the snippet, lists every Caller Agent granted this AI model. A suspended one is listed with a Suspended chip. You need to be able to read the Organization's members to see the list.

To let one Agent call a second AI model, such as the embedding model beside the chat model, open it in Settings, Agents, choose **Manage access**, and grant it that AI model too. Keys, suspension and removal are managed there as well.

## 3. Give the calling Service the endpoint and the key

Put both into the calling Service's own **Variables** tab. The OpenAI SDKs for Python and JavaScript read two names on their own, so with these set, a client built with no arguments is already pointed at the AI model:

```
OPENAI_BASE_URL=https://<console domain>/ai/<AI model id>/v1
OPENAI_API_KEY=<the caller Agent's key>
```

If your front end or vector store reads other names, use those instead. Most such tools have a setting for an "OpenAI-compatible" or "custom OpenAI" base URL. Also store the model name the AI model serves, for example as `AI_MODEL`, because every call must name it.

Set these on the Service itself. A Service is deployed with its own variables only. Its Environment's and its Project's are not inherited, and are reached only by naming them. Saving a variable does not change the running container. Deploy the Service after you save.

The calling Service can run anywhere: on the same Server as the AI model, on another one, in another Project, or outside Cloudgate. Every caller uses the same public endpoint.

## Examples

These use the OpenAI Python client (`pip install openai`), with the two variables above set and the served model in `AI_MODEL`. They work the same way from any OpenAI client, because the gateway speaks the OpenAI API whatever runtime is behind it.

### A chat completion

```python
import os
from openai import OpenAI

client = OpenAI()  # reads OPENAI_BASE_URL and OPENAI_API_KEY

reply = client.chat.completions.create(
    model=os.environ["AI_MODEL"],
    messages=[{"role": "user", "content": "Summarise our refund policy."}],
)
print(reply.choices[0].message.content)
```

### A streamed chat completion

```python
stream = client.chat.completions.create(
    model=os.environ["AI_MODEL"],
    messages=[{"role": "user", "content": "Write a haiku about deploys."}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

Each event is passed on as soon as the runtime produces it. The gateway sets no deadline on a call, so a long answer is not cut off.

The gateway always asks the runtime for the usage of a stream, so that it can count the tokens. It passes the usage chunk on to the caller only if the caller asked for it with `stream_options={"include_usage": True}`. That last chunk has an empty `choices`, which is why the loop above checks `chunk.choices` first.

If the caller hangs up mid-stream, the gateway cancels the runtime's request too. The tokens produced so far are still counted.

If you run a reverse proxy of your own in front of Cloudgate, it must not buffer responses under `/ai/`. The gateway sends `X-Accel-Buffering: no`, which nginx obeys, and `Cache-Control: no-cache` on a stream. Any other proxy needs buffering turned off for that path.

### Embeddings

The AI model you call here has to serve an embedding model. It is a separate AI model with its own endpoint, so give the Service its endpoint and model as two more variables, and build a second client for it. The same caller Agent's key works for both once its access includes both AI models.

```python
embedder = OpenAI(base_url=os.environ["AI_EMBEDDING_BASE_URL"])

result = embedder.embeddings.create(
    model=os.environ["AI_EMBEDDING_MODEL"],
    input=["First chunk of the document", "Second chunk"],
)
vectors = [item.embedding for item in result.data]
```

`GET /v1/models` also works, for clients that list models before calling one.

## What the gateway refuses

The gateway forwards four calls: `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/embeddings` and `GET /v1/models`. Every refusal is OpenAI-shaped (`{"error": {"message", "type", "code"}}`), so an OpenAI client raises it as an API error with the sentence below. No refused call reaches the runtime.

| Status | Message | Why |
|---|---|---|
| 401 | `Key refused` | The key is unknown, revoked, expired or a personal key, or the Agent is suspended. All five get the same answer, so a key cannot learn which. |
| 404 | `AI model not found or not permitted` | There is no AI model with that id in the key's Organization, or the Agent is not on the Caller role, or its grant does not include this AI model. All of these get the same answer, so a key cannot map which AI models exist. |
| 404 | `The gateway forwards only POST /v1/chat/completions, POST /v1/completions, POST /v1/embeddings and GET /v1/models` | Any other path or method under the AI model. That includes the runtime's own API, such as Ollama's `/api/*`. |
| 400 | `This AI model serves '<model>'; set "model" to it` | The body's `model` is not the model the AI model serves. The gateway never rewrites it. |
| 503 | `AI model is not running` | The AI model has never been deployed, or it is stopped. |
| 502 | `AI model did not answer` | The gateway could not reach the runtime on its Server, or lost it before the answer began. |

Anything else comes from the runtime itself and is passed on as it answered. One example is a runtime error while the model is still loading.

**Changing the model moves the hold at once.** When you save a new **Model** on the Model tab, the gateway starts holding calls to the new name immediately. The runtime does not serve it until the next Deployment finishes. Between the save and the end of that Deployment, callers that name the old model get the 400 above, and callers that name the new one reach a runtime that does not have it yet. Plan the change as save, deploy, then update the callers.

## Token spend

Every call that gets past the key check is recorded as one usage entry when it settles: finished, broken off, or abandoned by its caller. It is **Token spend of the AI model**, not of the caller. It adds up to the AI model's own Environment and Project, and it is broken down by the Agent that called. A Service in Project B that calls Project A's AI model spends Project A's tokens. Each entry records:

- The calling Agent's name, which the entry keeps after the Agent is removed.
- The endpoint, and whether the call was streamed.
- Prompt and completion tokens, each marked **reported** (from the runtime's own `usage`) or **estimated**. The gateway estimates with a tokenizer when the runtime never reports usage, as when a stream is cut. The estimate uses one tokenizer for every model, so it is only approximate.
- How the call ended: `ok`, `runtime-error`, `client-aborted`, or `refused`. A refused call spends zero tokens.

A call refused for its key leaves no entry, because there is no caller to name. A gateway call is never written to the audit log. Its usage entry is the record. Each usage entry is kept for 90 days. Every night, finished days are also rolled up into daily totals per Agent and model, and those are kept for as long as the AI model exists. Both are deleted with the AI model, its Environment or its Project.

Anyone who can read the AI model can read its Token spend. The REST API's `GET /applications/:id/token-spend` answers it by UTC day, with optional `from` and `to` days, and breaks it down by Agent and model. It takes a personal key, as the rest of the REST API does.

In the console, the **Token spend** section on the AI model's **Model** tab shows the same read over the last 7, 30 or 90 UTC days, or since the AI model was created. A daily chart stacks each day's estimated tokens, striped, on its reported ones, and a table lists each Agent and model with its calls per outcome. A removed Agent keeps its row under the name it had, marked **Removed**.

An Environment's facts show **Token spend, 30 days**: the tokens its AI models spent over the last 30 UTC days. Its **Services** tab gives each AI model its own figure in the same column. A Project's facts show the same total, then one line per Environment that holds an AI model, so production and staging read side by side. Both totals count only the AI models you can read, so two people may see different totals. The REST API answers them by UTC day as `GET /environments/:id/token-spend` and `GET /projects/:id/token-spend`, over the last 30 days unless you give `from` and `to`.

## Known gaps

- **No rate limit per Agent.** Unlike `/mcp`, the gateway does not cap how often a caller Agent calls. It also sets no deadline. A runaway caller is bounded only by what the runtime can serve. To stop one, **Suspend** its Agent in Settings, Agents. New calls then get "Key refused". A call already running finishes and is counted, and so does a call whose key is revoked while it runs.
- **A backend restart cuts every running call.** The gateway runs inside the backend process, so a restart or upgrade breaks open streams and requests mid-answer. Callers should retry.
- **A caller on Server X goes through the platform host.** Every call enters at the console's domain, on the platform host, and goes back out to the AI model's Server. That happens even when the caller and the AI model share a Server. Expect the extra latency, and that every prompt and answer travels between the platform host and the Server.
- **The last hop is plain HTTP.** From the platform host, the gateway reaches the AI model through its Server's Traefik over plain HTTP on the `web` entry point. A per-AI-model secret guards that hop. Prompts and answers cross the network between the two hosts unencrypted, so keep Servers that run AI models on a network you trust.
- **Don't put an LLM gateway of your own in front.** A proxy such as LiteLLM that holds one Cloudgate key and fans out to many callers makes all of their calls one Agent's. That collapses the per-Agent breakdown and removes your way to suspend one caller alone. Give each Service its own caller Agent and point it at the endpoint directly.
- **Cloudgate's own AI features on a private address.** You can point Cloudgate's own AI provider at an AI model, in Settings, AI, with **Add a provider**. Give it the endpoint as the URL and a caller Agent's key, and the console's AI features then run on your model, counted like any other caller's. But the URL must pass Cloudgate's check on private addresses. So on an install with several Organizations whose console domain resolves to a private address, an owner of any Organization other than the instance's own cannot point the AI provider at the gateway by that address. A single-Organization install, as the installer sets up, is not affected.
