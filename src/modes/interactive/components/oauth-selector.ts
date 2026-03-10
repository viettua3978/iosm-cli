import { getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import { Container, getEditorKeybindings, Spacer, TruncatedText } from "@mariozechner/pi-tui";
import type { AuthStorage } from "../../../core/auth-storage.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

type LoginProviderKind = "oauth" | "api_key";

type LoginProviderOption = {
	id: string;
	name: string;
	kind: LoginProviderKind;
};

const API_KEY_LOGIN_PROVIDERS: LoginProviderOption[] = [{ id: "openrouter", name: "OpenRouter", kind: "api_key" }];

/**
 * Component that renders an OAuth provider selector
 */
export class OAuthSelectorComponent extends Container {
	private listContainer: Container;
	private allProviders: LoginProviderOption[] = [];
	private selectedIndex: number = 0;
	private mode: "login" | "logout";
	private authStorage: AuthStorage;
	private onSelectCallback: (providerId: string) => void;
	private onCancelCallback: () => void;

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
	) {
		super();

		this.mode = mode;
		this.authStorage = authStorage;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Load all OAuth providers
		this.loadProviders();

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		const title = mode === "login" ? "Select provider to authenticate:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.bold(title)));
		if (mode === "login") {
			this.addChild(new TruncatedText(theme.fg("muted", "OAuth + API key providers")));
		}
		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Initial render
		this.updateList();
	}

	private loadProviders(): void {
		const oauthProviders: LoginProviderOption[] = getOAuthProviders().map((provider) => ({
			id: provider.id,
			name: provider.name,
			kind: "oauth",
		}));

		if (this.mode === "login") {
			const merged = [...oauthProviders];
			for (const provider of API_KEY_LOGIN_PROVIDERS) {
				if (!merged.some((candidate) => candidate.id === provider.id)) {
					merged.push(provider);
				}
			}
			this.allProviders = merged;
			return;
		}

		// Logout mode: show only providers with saved credentials in auth.json.
		const savedCredentialsProviders = [...oauthProviders];
		for (const provider of API_KEY_LOGIN_PROVIDERS) {
			if (this.authStorage.has(provider.id) && !savedCredentialsProviders.some((candidate) => candidate.id === provider.id)) {
				savedCredentialsProviders.push(provider);
			}
		}

		this.allProviders = savedCredentialsProviders.filter((provider) => {
			const credentials = this.authStorage.get(provider.id);
			if (!credentials) return false;
			if (provider.kind === "oauth") return credentials.type === "oauth";
			return credentials.type === "api_key";
		});
	}

	private updateList(): void {
		this.listContainer.clear();

		for (let i = 0; i < this.allProviders.length; i++) {
			const provider = this.allProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			// Check if user is authenticated for this provider
			const credentials = this.authStorage.get(provider.id);
			const isConfigured =
				provider.kind === "oauth"
					? credentials?.type === "oauth"
					: credentials?.type === "api_key" || this.authStorage.hasAuth(provider.id);
			const statusIndicator = isConfigured
				? provider.kind === "oauth"
					? theme.fg("success", " ✓ logged in")
					: theme.fg("success", " ✓ key configured")
				: "";
			const providerKindBadge = provider.kind === "api_key" ? theme.fg("warning", " [API key]") : "";

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const text = theme.fg("accent", provider.name);
				line = prefix + text + providerKindBadge + statusIndicator;
			} else {
				const text = `  ${provider.name}`;
				line = text + providerKindBadge + statusIndicator;
			}

			this.listContainer.addChild(new TruncatedText(line, 0, 0));
		}

		// Show "no providers" if empty
		if (this.allProviders.length === 0) {
			const message =
				this.mode === "login"
					? "No providers available"
					: "No saved provider credentials. Use /login first.";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		// Up arrow
		if (kb.matches(keyData, "selectUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		}
		// Down arrow
		else if (kb.matches(keyData, "selectDown")) {
			this.selectedIndex = Math.min(this.allProviders.length - 1, this.selectedIndex + 1);
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "selectConfirm")) {
			const selectedProvider = this.allProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
		}
	}
}
