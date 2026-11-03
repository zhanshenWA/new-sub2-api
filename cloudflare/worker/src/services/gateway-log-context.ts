// Request metadata only: never persist authorization headers, query strings or bodies.
export interface GatewayLogContext {
    reasoningEffort: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    inboundEndpoint: string;
    upstreamEndpoint?: string | null;
}

function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
}

function bounded(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text ? text.slice(0, max) : null;
}

export function gatewayLogContext(request: Request, body: Record<string, unknown>): GatewayLogContext {
    return {
        reasoningEffort: bounded(body.reasoning_effort ?? object(body.reasoning).effort, 64),
        ipAddress: bounded(request.headers.get("cf-connecting-ip"), 64),
        userAgent: bounded(request.headers.get("user-agent"), 512),
        inboundEndpoint: new URL(request.url).pathname
    };
}

// Ignore role, heartbeat and usage events when measuring the first generated output.
export function hasGatewayOutput(data: Record<string, unknown>): boolean {
    const nonempty = (value: unknown): boolean => typeof value === "string" && value.length > 0;
    const content = (value: unknown): boolean => nonempty(value) ||
        (Array.isArray(value) && value.some(part => nonempty(object(part).text)));
    if (Array.isArray(data.choices) && data.choices.some(choice => {
        const delta = object(object(choice).delta);
        return content(delta.content) || nonempty(delta.reasoning_content) || nonempty(delta.reasoning) ||
            nonempty(delta.refusal) || (Array.isArray(delta.tool_calls) && delta.tool_calls.some(call => {
                const fn = object(object(call).function);
                return nonempty(fn.name) || nonempty(fn.arguments);
            }));
    })) return true;
    const event = typeof data.type === "string" ? data.type : "";
    if (/^response[.](output_text|reasoning_text|reasoning_summary_text|function_call_arguments)[.]delta$/.test(event)) {
        return nonempty(data.delta);
    }
    if (event === "content_block_delta") {
        const delta = object(data.delta);
        return nonempty(delta.text) || nonempty(delta.thinking) || nonempty(delta.partial_json);
    }
    if (event === "content_block_start") {
        const block = object(data.content_block);
        return nonempty(block.text) || (block.type === "tool_use" && nonempty(block.name));
    }
    return Array.isArray(data.candidates) && data.candidates.some(candidate => {
        const parts = object(object(candidate).content).parts;
        return Array.isArray(parts) && parts.some(part => nonempty(object(part).text) ||
            nonempty(object(object(part).functionCall).name));
    });
}
