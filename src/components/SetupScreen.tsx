interface SetupScreenProps {
  error: string | null;
}

export default function SetupScreen({ error }: SetupScreenProps) {
  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h1>RayClaw Desktop</h1>
        <p className="setup-subtitle">Configuration required</p>

        <div className="setup-message">
          {error && <p className="setup-error">{error}</p>}
          <p>
            RayClaw needs a configuration file to connect to your LLM provider.
          </p>
        </div>

        <div className="setup-steps">
          <h3>Quick setup</h3>
          <ol>
            <li>
              Install RayClaw:{" "}
              <code>cargo install rayclaw --features all</code>
            </li>
            <li>
              Run the setup wizard: <code>rayclaw setup</code>
            </li>
            <li>Restart this app</li>
          </ol>
          <p className="setup-hint">
            Or create <code>rayclaw.config.yaml</code> manually in the current
            directory or <code>~/.rayclaw/</code>.
          </p>
        </div>

        <div className="setup-example">
          <h3>Minimal config</h3>
          <pre>{`llm_provider: anthropic
api_key: sk-ant-...
model: claude-sonnet-4-5-20250929`}</pre>
        </div>
      </div>
    </div>
  );
}
