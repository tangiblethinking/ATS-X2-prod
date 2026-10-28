import { createRouter } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    // Browser URL is /job on uxapex.com; match routes relative to that.
    basepath: "/job",
    trailingSlash: "never",
  });
}
