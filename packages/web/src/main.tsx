import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { AudioProvider } from "./public-share/audio";
import "./styles.css";

const root = createRootRoute({ component: App });
const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: "/" }),
  createRoute({ getParentRoute: () => root, path: "/files" }),
  createRoute({ getParentRoute: () => root, path: "/files/$folderId" }),
  createRoute({ getParentRoute: () => root, path: "/gallery" }),
  createRoute({ getParentRoute: () => root, path: "/gallery/$folderId" }),
  createRoute({ getParentRoute: () => root, path: "/audio" }),
  createRoute({ getParentRoute: () => root, path: "/audio/$folderId" }),
  createRoute({ getParentRoute: () => root, path: "/library" }),
  createRoute({ getParentRoute: () => root, path: "/library/$folderId" }),
  createRoute({ getParentRoute: () => root, path: "/trash" }),
  createRoute({ getParentRoute: () => root, path: "/shared" }),
  createRoute({ getParentRoute: () => root, path: "/shared/$shareId" }),
  createRoute({
    getParentRoute: () => root,
    path: "/shared/$shareId/$nodeId",
    validateSearch: (search: Record<string, unknown>): { view?: "library" } =>
      search.view === "library" ? { view: "library" } : {},
  }),
]);
const router = createRouter({ routeTree });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
const query = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, gcTime: 300_000 },
    mutations: { retry: false },
  },
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={query}>
    <AudioProvider>
      <RouterProvider router={router} />
    </AudioProvider>
  </QueryClientProvider>,
);
