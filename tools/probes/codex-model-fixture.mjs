// Deterministic localhost model metadata, not a production model or capability
// override. Avoid relying on an old model slug staying in the CLI's bundled
// catalog: fallback metadata in 0.162.0 omits the native apply_patch tool.
// model_catalog_json is a supported startup input; the descriptor uses the
// native freeform patch/unified-exec profile observed in the shipped catalog.
export const codexProbeCatalog = {
  models: ['gpt-5.4', 'probe'].map((slug) => ({
    slug,
    display_name: 'Local deterministic policy probe',
    description: 'Offline tool interception fixture; no model inference',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [{ effort: 'low', description: 'Fixture' }],
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    base_instructions: 'Run the supplied native tool operation.',
    include_apply_patch_tool: true,
    apply_patch_tool_type: 'freeform',
    default_reasoning_summary: 'none',
    support_verbosity: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    input_modalities: ['text'],
    experimental_supported_tools: [],
    context_window: 272000,
    effective_context_window_percent: 95,
    supports_reasoning_summaries: false,
  })),
};
