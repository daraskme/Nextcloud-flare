export function routeContracts(design) {
  const rows = design.split(/\r?\n/).filter((line) => /^\| (app|content) \|/.test(line));
  const routes = rows.flatMap((line) => {
    const [host, method, template, auth, operation, operands, adminOnly, csrf] = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replaceAll("`", ""));
    const route = {
      host,
      method,
      template,
      auth: [auth],
      operation,
      operands: operands.split(","),
      adminOnly: adminOnly === "true",
      csrf,
    };
    if (template === "/api/v1/csrf") route.csrf = "csrf-issue";
    if (template === "/api/v1/operations/:id") route.auth = ["access", "app_password", "share"];
    return template === "/dav/*path" ? [{ ...route, template: "/dav" }, route] : [route];
  });
  routes.push({
    host: "app",
    method: "POST",
    template: "/api/v1/public/shares/:shareId/csrf",
    auth: ["share"],
    operation: "csrf.issue",
    operands: ["share", "session"],
    adminOnly: false,
    csrf: "public-csrf-issue",
  });
  return routes;
}
