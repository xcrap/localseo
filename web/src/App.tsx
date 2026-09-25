import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type SyntheticEvent,
	type ReactNode,
} from "react";
import {
	BrowserRouter,
	Link,
	NavLink,
	Route,
	Routes,
	useLocation,
	useNavigate,
} from "react-router-dom";
import {
	Activity,
	Circle,
	FileSearch,
	FolderKanban,
	Gauge,
	KeyRound,
	LayoutGrid,
	LogOut,
	RefreshCw,
	Search,
	Settings,
	ShieldCheck,
} from "lucide-react";
import { api, auth, type Site } from "./api";
import {
	ActiveSiteSelect,
	EmptyState,
	Field,
	SiteAvatar,
	activeSiteStorageKey,
	navGroups,
	navItems,
	setSelectedScanId,
	siteDisplayName,
} from "./app/shared";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Checkbox,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Skeleton,
	Toaster,
	toast,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
	CommandPalette,
	shortcutLabel,
	useAppShortcuts,
} from "./app/command-palette";
import { NotificationBell } from "./app/notifications";

// Page modules load on demand so the shell paints before the heavy report UI.
const KeywordsPage = lazy(() =>
	import("./app/pages/keywords").then((m) => ({ default: m.KeywordsPage })),
);
const RankPage = lazy(() =>
	import("./app/pages/rank").then((m) => ({ default: m.RankPage })),
);
const SavedPage = lazy(() =>
	import("./app/pages/keywords").then((m) => ({ default: m.SavedPage })),
);
const SerpPage = lazy(() =>
	import("./app/pages/keywords").then((m) => ({ default: m.SerpPage })),
);
const DomainPage = lazy(() =>
	import("./app/pages/research").then((m) => ({ default: m.DomainPage })),
);
const LinksPage = lazy(() =>
	import("./app/pages/research").then((m) => ({ default: m.LinksPage })),
);
const BrandLookupPage = lazy(() =>
	import("./app/pages/discovery").then((m) => ({ default: m.BrandLookupPage })),
);
const PromptExplorerPage = lazy(() =>
	import("./app/pages/discovery").then((m) => ({
		default: m.PromptExplorerPage,
	})),
);
const AiPage = lazy(() =>
	import("./app/pages/integrations").then((m) => ({ default: m.AiPage })),
);
const GscPage = lazy(() =>
	import("./app/pages/gsc").then((m) => ({ default: m.GscPage })),
);
const McpPage = lazy(() =>
	import("./app/pages/integrations").then((m) => ({ default: m.McpPage })),
);
const SettingsPage = lazy(() =>
	import("./app/pages/integrations").then((m) => ({ default: m.SettingsPage })),
);
const ScansPage = lazy(() =>
	import("./app/pages/scans").then((m) => ({ default: m.ScansPage })),
);
const InsightsPage = lazy(() =>
	import("./app/pages/insights").then((m) => ({ default: m.InsightsPage })),
);
const Overview = lazy(() =>
	import("./app/pages/sites").then((m) => ({ default: m.Overview })),
);
const SitesManager = lazy(() =>
	import("./app/pages/sites").then((m) => ({ default: m.SitesManager })),
);

function PageFallback() {
	return (
		<div className="space-y-5" role="status" aria-busy="true" aria-label="Loading page">
			<Skeleton className="h-9 w-64" />
			<Skeleton className="h-32 rounded-2xl" />
			<Skeleton className="h-64 rounded-2xl" />
		</div>
	);
}

function LoginScreen({
	setupRequired,
	onSuccess,
}: {
	setupRequired: boolean;
	onSuccess: () => void;
}) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [remember, setRemember] = useState(true);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	async function submit(event: SyntheticEvent) {
		event.preventDefault();
		setLoading(true);
		setError("");
		try {
			if (setupRequired) await auth.setup(email, password);
			else await auth.login(email, password, remember);
			onSuccess();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Authentication failed");
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="grain flex min-h-screen items-center justify-center px-5">
			<Card className="rise relative z-10 w-full max-w-md">
				<CardHeader className="space-y-3">
					<div className="flex items-center gap-3">
						<div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
							<ShieldCheck className="size-4.5" />
						</div>
						<div>
							<CardTitle className="font-heading text-2xl font-medium">
								Local SEO
							</CardTitle>
							<CardDescription>
								{setupRequired
									? "Create the single local admin."
									: "Welcome back."}
							</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					{setupRequired ? (
						<p className="mb-4 rounded-lg bg-muted/40 px-3.5 py-2.5 text-[13px] leading-5 text-muted-foreground">
							One local admin account for this install. SQLite is the source of
							truth on this machine — no hosted auth service is required.
						</p>
					) : null}
					<form className="space-y-4" onSubmit={submit} autoComplete="on">
						<Field label="Email">
							<Input
								id="auth-email"
								name="username"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								type="email"
								autoComplete="username"
								required
							/>
						</Field>
						<Field label="Password">
							<Input
								id="auth-password"
								name="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								type="password"
								autoComplete={setupRequired ? "new-password" : "current-password"}
								required
								minLength={10}
							/>
						</Field>
						{!setupRequired && (
							<label className="flex items-center gap-2 text-sm text-muted-foreground">
								<Checkbox
									checked={remember}
									onCheckedChange={(checked) => setRemember(checked === true)}
								/>
								Keep me signed in
							</label>
						)}
						{error && <p className="text-sm text-destructive">{error}</p>}
						<Button className="w-full" type="submit" disabled={loading}>
							<KeyRound />
							{loading
								? "Working..."
								: setupRequired
									? "Create admin"
									: "Sign in"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}

function AppRoot({ onLogout }: { onLogout: () => void }) {
	return (
		<BrowserRouter>
			<AppShell onLogout={onLogout} />
		</BrowserRouter>
	);
}

function AppShell({ onLogout }: { onLogout: () => void }) {
	const [sites, setSites] = useState<Site[]>([]);
	const [activeSiteId, setActiveSiteId] = useState(
		localStorage.getItem(activeSiteStorageKey) || "",
	);
	const activeSiteIdRef = useRef(activeSiteId);
	const [sitesLoading, setSitesLoading] = useState(true);
	const [sitesError, setSitesError] = useState("");
	const [shellScanning, setShellScanning] = useState(false);
	const navigate = useNavigate();
	const location = useLocation();
	const activeSite = useMemo(
		() => sites.find((site) => site.id === activeSiteId) || sites[0],
		[sites, activeSiteId],
	);

	function storeActiveSiteId(id: string) {
		activeSiteIdRef.current = id;
		setActiveSiteId(id);
		if (id) localStorage.setItem(activeSiteStorageKey, id);
		else localStorage.removeItem(activeSiteStorageKey);
	}

	async function loadSites() {
		if (!sites.length) setSitesLoading(true);
		setSitesError("");
		try {
			const rows = await api.sites();
			setSites(rows);
			if (rows.length === 0) {
				storeActiveSiteId("");
				return;
			}
			if (
				rows.length > 0 &&
				!rows.some((site) => site.id === activeSiteIdRef.current)
			) {
				const nextActive = rows[0];
				storeActiveSiteId(nextActive.id);
			}
		} catch (err) {
			setSitesError(
				err instanceof Error ? err.message : "Could not load local sites",
			);
			throw err;
		} finally {
			setSitesLoading(false);
		}
	}

	useEffect(() => {
		loadSites().catch(console.error);
	}, []);

	const [paletteOpen, setPaletteOpen] = useState(false);
	useAppShortcuts(() => setPaletteOpen((open) => !open));

	function selectSite(id: string, options: { keepPath?: boolean } = {}) {
		const changed = id !== activeSiteIdRef.current;
		storeActiveSiteId(id);
		if (
			changed &&
			!options.keepPath &&
			/^\/scans\/[^/]+/.test(location.pathname)
		) {
			navigate("/scans", { replace: true });
		}
	}

	// A deep link to a scan saved for another site switches the workspace to
	// that site and keeps the link, instead of silently showing another scan.
	const switchToScanSite = useCallback(
		(siteId: string) => {
			const target = sites.find((site) => site.id === siteId);
			if (!target) return false;
			selectSite(siteId, { keepPath: true });
			toast.info(`Switched to ${siteDisplayName(target)} to open this scan.`);
			return true;
		},
		[sites],
	);

	async function scanActiveSite() {
		if (!activeSite?.domain) {
			navigate("/");
			return;
		}
		const scanSiteId = activeSite.id;
		setShellScanning(true);
		try {
			const result = await api.scanSite(scanSiteId);
			if (result.scan?.id) {
				setSelectedScanId(scanSiteId, result.scan.id);
			}
			if (activeSiteIdRef.current !== scanSiteId) {
				return;
			}
			// Land on the scans workspace (which carries the scan context bar and
			// switcher) rather than the focused single-scan page, so the user can
			// move between scans without a "Back to scans" detour.
			navigate("/scans");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Could not start site scan",
			);
		} finally {
			setShellScanning(false);
		}
	}

	async function logout() {
		await auth.logout().catch(() => undefined);
		setShellScanning(false);
		onLogout();
	}

	const isHome =
		location.pathname === "/" ||
		location.pathname === "/sites" ||
		location.pathname === "/settings";

	if (sitesError) {
		return (
			<div className="grain flex min-h-screen items-center justify-center px-5">
				<div className="relative z-10 w-full max-w-md">
					<EmptyState
						title="Could not load local sites"
						text={`${sitesError}. Your SQLite data was not cleared; the app could not read it from the local API.`}
						action={
							<Button
								type="button"
								onClick={() => loadSites().catch(console.error)}
							>
								<RefreshCw /> Retry
							</Button>
						}
					/>
				</div>
			</div>
		);
	}

	if (sitesLoading) {
		return (
			<div className="grain flex min-h-screen items-center justify-center">
				<div className="relative z-10 flex items-center gap-3 text-sm text-muted-foreground">
					<Circle className="size-3 animate-pulse fill-primary text-primary" />
					Loading local SQLite sites…
				</div>
			</div>
		);
	}

	const requireSite = (element: ReactNode) =>
		activeSite ? element : <NoSiteSelected />;
	// The entrance animation replays per section (/scans, /keywords, …) but not
	// when only a sub-path or query changes, so /scans → /scans/:id keeps the
	// mounted page and its state.
	const sectionKey = location.pathname.split("/")[1] || "home";
	const palette = (
		<CommandPalette
			open={paletteOpen}
			onOpenChange={setPaletteOpen}
			sites={sites}
			activeSite={activeSite}
			onSelectSite={selectSite}
			onScanActiveSite={scanActiveSite}
		/>
	);

	if (isHome) {
		return (
			<div className="grain min-h-screen">
				<TopBar
					onLogout={logout}
					onOpenPalette={() => setPaletteOpen(true)}
					onOpenNotificationSite={selectSite}
				/>
				<main
					key={sectionKey}
					className="rise relative z-10 mx-auto w-full max-w-[1560px] px-5 pb-16 pt-7 lg:px-10 lg:pt-8"
				>
					<Suspense fallback={<PageFallback />}>
						<Routes>
							<Route
								path="/"
								element={
									<SitesManager
										sites={sites}
										reloadSites={loadSites}
										activeSiteId={activeSite?.id || ""}
										selectSite={selectSite}
									/>
								}
							/>
							<Route
								path="/sites"
								element={
									<SitesManager
										sites={sites}
										reloadSites={loadSites}
										activeSiteId={activeSite?.id || ""}
										selectSite={selectSite}
									/>
								}
							/>
							<Route path="/settings" element={<SettingsPage />} />
						</Routes>
					</Suspense>
				</main>
				{palette}
			</div>
		);
	}

	return (
		<div className="grain min-h-screen">
			<TopBar
				onLogout={logout}
				onOpenPalette={() => setPaletteOpen(true)}
				sites={sites}
				activeSiteId={activeSite?.id || ""}
				onSelectSite={selectSite}
				onOpenNotificationSite={selectSite}
			/>
			<WorkspaceSidebar />
			<WorkspaceMobileHeader
				sites={sites}
				activeSite={activeSite}
				onSelect={selectSite}
				onScan={scanActiveSite}
				scanning={shellScanning}
				onNavigate={(path) => navigate(path)}
			/>
			{palette}
			<main className="relative z-10 px-4 py-6 lg:ml-66 lg:px-9 lg:py-8">
				<div key={sectionKey} className="rise mx-auto w-full max-w-[1640px]">
					<Suspense fallback={<PageFallback />}>
					<Routes key={activeSite?.id || "no-site"}>
						<Route
							path="/overview"
							element={requireSite(
								activeSite ? (
									<Overview
										site={activeSite}
										reloadSites={loadSites}
										selectSite={selectSite}
									/>
								) : null,
							)}
						/>
						<Route
							path="/keywords"
							element={requireSite(
								activeSite ? <KeywordsPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/serp"
							element={requireSite(
								activeSite ? <SerpPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/saved"
							element={requireSite(
								activeSite ? <SavedPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/rank"
							element={requireSite(
								activeSite ? <RankPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/domain"
							element={requireSite(
								activeSite ? <DomainPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/links"
							element={requireSite(
								activeSite ? <LinksPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/brand"
							element={requireSite(
								activeSite ? <BrandLookupPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/prompts"
							element={requireSite(
								activeSite ? <PromptExplorerPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/scans/:scanId?"
							element={requireSite(
								activeSite ? (
									<ScansPage site={activeSite} switchSite={switchToScanSite} />
								) : null,
							)}
						/>
						<Route
							path="/insights"
							element={requireSite(
								activeSite ? <InsightsPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/gsc"
							element={requireSite(
								activeSite ? <GscPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/ai"
							element={requireSite(
								activeSite ? <AiPage site={activeSite} /> : null,
							)}
						/>
						<Route
							path="/mcp-tools"
							element={requireSite(
								activeSite ? <McpPage site={activeSite} /> : null,
							)}
						/>
						<Route path="*" element={<NotFoundPage />} />
					</Routes>
					</Suspense>
				</div>
			</main>
		</div>
	);
}

function BrandMark({ compact = false }: { compact?: boolean }) {
	return (
		<div className="flex items-center gap-2.5">
			<div className="flex size-7.5 items-center justify-center rounded-md bg-primary text-primary-foreground">
				<Activity className="size-4" />
			</div>
			{!compact ? (
				<span className="font-heading text-[17px] leading-none tracking-tight">
					Local SEO
				</span>
			) : null}
		</div>
	);
}

function TopBar({
	onLogout,
	onOpenPalette,
	sites,
	activeSiteId,
	onSelectSite,
	onOpenNotificationSite,
}: {
	onLogout: () => void;
	onOpenPalette: () => void;
	sites?: Site[];
	activeSiteId?: string;
	onSelectSite?: (id: string) => void;
	onOpenNotificationSite?: (
		id: string,
		options?: { keepPath?: boolean },
	) => void;
}) {
	const location = useLocation();
	const onSettings = location.pathname === "/settings";
	return (
		<header className="sticky top-0 z-40 h-14 border-b border-border/70 bg-background/85 backdrop-blur-md">
			<div className="flex h-full items-center justify-between gap-3 px-4 lg:px-6">
				<div className="flex min-w-0 items-center gap-2">
					<Link to="/" aria-label="All sites">
						<BrandMark />
					</Link>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-8 gap-2 text-muted-foreground"
						onClick={onOpenPalette}
						aria-keyshortcuts="Meta+K Control+K"
					>
						<Search />
						<span className="hidden md:inline">Jump to…</span>
						<kbd className="hidden rounded border border-border/80 px-1.5 font-sans text-[10px] text-muted-foreground md:inline">
							{shortcutLabel()}
						</kbd>
						<span className="sr-only md:hidden">Open command palette</span>
					</Button>
					{onSelectSite && sites && sites.length > 1 ? (
						<div className="hidden w-56 lg:block">
							<ActiveSiteSelect
								sites={sites}
								activeSiteId={activeSiteId || ""}
								onSelect={onSelectSite}
							/>
						</div>
					) : null}
					<NotificationBell onSelectSite={onOpenNotificationSite} />
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								asChild
								variant={onSettings ? "secondary" : "ghost"}
								size="icon"
								className="size-8 text-muted-foreground hover:text-foreground"
							>
								<Link to="/settings" aria-label="Settings">
									<Settings />
								</Link>
							</Button>
						</TooltipTrigger>
						<TooltipContent>Settings</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="size-8 text-muted-foreground hover:text-foreground"
								aria-label="Sign out"
								onClick={onLogout}
							>
								<LogOut />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Sign out</TooltipContent>
					</Tooltip>
				</div>
			</div>
		</header>
	);
}

function WorkspaceSidebar() {
	return (
		<aside className="fixed bottom-0 left-0 top-14 z-20 hidden w-66 flex-col overflow-hidden border-r border-border/70 bg-surface/85 backdrop-blur lg:flex">
			<nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-5 pt-4">
				{navGroups.map((group) => (
					<div key={group.label} className="space-y-0.5">
						<div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
							{group.label}
						</div>
						{group.items.map(({ to, label, icon: Icon }) => (
							<NavLink
								key={to}
								to={to}
								className={({ isActive }) =>
									cn(
										"group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
										isActive
											? "bg-primary/8 text-primary"
											: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
									)
								}
							>
								<Icon className="size-4 shrink-0 opacity-80" />
								{label}
							</NavLink>
						))}
					</div>
				))}
			</nav>
		</aside>
	);
}

function WorkspaceMobileHeader({
	sites,
	activeSite,
	onSelect,
	onScan,
	scanning,
	onNavigate,
}: {
	sites: Site[];
	activeSite?: Site | null;
	onSelect: (id: string) => void;
	onScan: () => void;
	scanning: boolean;
	onNavigate: (path: string) => void;
}) {
	return (
		<div className="sticky top-14 z-20 border-b border-border/70 bg-background/85 px-4 py-3 backdrop-blur lg:hidden">
			<div className="flex items-center gap-2.5 rounded-xl border border-border/80 bg-card p-2.5">
				<SiteAvatar site={activeSite} className="size-9" />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-semibold">
						{activeSite ? siteDisplayName(activeSite) : "No site selected"}
					</div>
					<div className="truncate text-xs text-muted-foreground">
						{activeSite?.domain || "Pick a site"}
					</div>
				</div>
				{activeSite?.domain ? (
					<Button size="sm" onClick={onScan} disabled={scanning}>
						<FileSearch /> {scanning ? "Scanning" : "Scan"}
					</Button>
				) : null}
			</div>
			<div className="mt-2 grid grid-cols-2 gap-2">
				{sites.length > 1 ? (
					<ActiveSiteSelect
						sites={sites}
						activeSiteId={activeSite?.id || ""}
						onSelect={onSelect}
					/>
				) : (
					<div />
				)}
				<Select value="" onValueChange={onNavigate}>
					<SelectTrigger>
						<SelectValue placeholder="Go to…" />
					</SelectTrigger>
					<SelectContent>
						{navItems.map((item) => (
							<SelectItem key={item.to} value={item.to}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</div>
	);
}

function NoSiteSelected() {
	return (
		<div className="py-10">
			<EmptyState
				title="Pick a site to continue"
				text="Your local data is grouped per site. Open one to see its overview, scans, keywords, and rankings."
				action={
					<Button asChild>
						<Link to="/">
							<LayoutGrid /> Browse all sites
						</Link>
					</Button>
				}
			/>
		</div>
	);
}

function NotFoundPage() {
	return (
		<div className="py-10">
			<h1 className="sr-only">Page not found</h1>
			<EmptyState
				title="Page not found"
				text="This screen is not part of the local SEO app."
				action={
					<>
						<Button asChild>
							<Link to="/overview">
								<Gauge /> Open overview
							</Link>
						</Button>
						<Button asChild variant="secondary">
							<Link to="/">
								<FolderKanban /> Manage sites
							</Link>
						</Button>
					</>
				}
			/>
		</div>
	);
}

export default function App() {
	const [checking, setChecking] = useState(true);
	const [authenticated, setAuthenticated] = useState(false);
	const [setupRequired, setSetupRequired] = useState(false);

	async function check() {
		try {
			const status = await auth.me();
			setAuthenticated(status.authenticated);
			setSetupRequired(Boolean(status.setupRequired));
		} catch (error: any) {
			setAuthenticated(false);
			setSetupRequired(Boolean(error?.message?.includes("401")));
			try {
				const response = await fetch("/api/auth/me", {
					credentials: "include",
				});
				const data = await response.json();
				setSetupRequired(Boolean(data.setupRequired));
			} catch {
				setSetupRequired(false);
			}
		} finally {
			setChecking(false);
		}
	}

	useEffect(() => {
		check();
	}, []);

	if (checking) {
		return (
			<div className="grain flex min-h-screen items-center justify-center">
				<div className="relative z-10 flex items-center gap-3 text-sm text-muted-foreground">
					<Circle className="size-3 animate-pulse fill-primary text-primary motion-reduce:animate-none" />
					Loading local data…
				</div>
			</div>
		);
	}

	return (
		<>
			{authenticated ? (
				<AppRoot onLogout={() => setAuthenticated(false)} />
			) : (
				<LoginScreen
					setupRequired={setupRequired}
					onSuccess={() => setAuthenticated(true)}
				/>
			)}
			<Toaster />
		</>
	);
}
