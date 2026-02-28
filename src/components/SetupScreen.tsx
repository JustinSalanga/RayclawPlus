import logoText from "../assets/logo-text.png";

interface SetupScreenProps {
  error: string | null;
  onConfigure: () => void;
}

export default function SetupScreen({ error, onConfigure }: SetupScreenProps) {
  return (
    <div className="setup-screen">
      <div className="setup-card">
        <img src={logoText} alt="RayClaw" className="setup-logo" />
        <h1>RayClaw Desktop</h1>
        <p className="setup-subtitle">Configuration required</p>

        <div className="setup-message">
          {error && <p className="setup-error">{error}</p>}
          <p>
            RayClaw needs an LLM provider and API key to get started.
          </p>
        </div>

        <button className="btn-configure" onClick={onConfigure}>
          Configure
        </button>

        <div className="setup-example">
          <h3>Supported providers</h3>
          <p className="setup-providers">
            Anthropic, OpenAI, AWS Bedrock, Ollama, Google, DeepSeek, OpenRouter, Mistral, and more
          </p>
        </div>
      </div>
    </div>
  );
}
