import { authClient } from "@/lib/auth-client";
import { Navigate, Outlet, useLocation } from "react-router-dom";

const isDesktopClient =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

export function AuthLayout() {
  const location = useLocation();
  const { data: session, isPending: authPending } = authClient.useSession();

  // Desktop uses activation codes, not better-auth sessions.
  // The controller guards API access; skip the session gate here.
  if (isDesktopClient) {
    return <Outlet />;
  }

  if (authPending) {
    return <div className="min-h-screen" />;
  }

  if (!session?.user) {
    return <Navigate to="/" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
