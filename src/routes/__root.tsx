import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Growth Track by Form" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
});

const NAV = [
  { to: "/", label: "Home" },
  { to: "/staff/people", label: "People" },
  { to: "/connect", label: "Connect Card" },
  { to: "/setup", label: "Setup state" },
] as const;

function NotFound() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <h1 className="text-xl font-semibold text-slate-900">Page not found</h1>
      <p className="mt-2 text-sm text-slate-600">
        That page does not exist. Try the <Link to="/" className="underline">home page</Link>.
      </p>
    </main>
  );
}

function NavBar() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <Link to="/" className="text-sm font-semibold tracking-tight text-slate-900">
          Growth Track <span className="font-normal text-slate-500">by Form</span>
        </Link>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {NAV.slice(1).map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="text-slate-600 transition-colors hover:text-slate-900"
              activeProps={{ className: "text-slate-900 font-medium" }}
            >
              {item.label}
            </Link>
          ))}
          <Link
            to="/login"
            className="text-slate-600 transition-colors hover:text-slate-900"
            activeProps={{ className: "text-slate-900 font-medium" }}
          >
            Staff sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}

function RootComponent() {
  return (
    <RootDocument>
      <NavBar />
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-dvh flex-col bg-slate-50 text-slate-900 antialiased">
        {children}
        <footer className="mt-auto border-t border-slate-200 bg-white">
          <div className="mx-auto w-full max-w-5xl px-6 py-4 text-xs text-slate-500">
            Growth Track by Form — the pipeline a church can&apos;t afford to lose:
            first-time guest to fully deployed, relationally-cared-for member.
          </div>
        </footer>
        <Scripts />
      </body>
    </html>
  );
}
