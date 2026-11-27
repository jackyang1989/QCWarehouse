"""Check the schedule, K01/L03/K03/K04/L04 DAG closure, and shared transaction schemas. Requires PyYAML and jsonschema."""
from pathlib import Path
import re
import yaml
from jsonschema import Draft202012Validator

DOCS = Path(__file__).resolve().parents[1]
board = (DOCS / "开发排期与任务台账.md").read_text()
spec = (DOCS / "开发规格.md").read_text()
prd = (DOCS / "QCWarehouse_PRD_v3_MultiCategory.md").read_text()
matrix = (DOCS / "生产级统一重构分包排期与需求追踪矩阵.md").read_text()
contract = yaml.safe_load((DOCS / "contracts/core.openapi.yaml").read_text())

STRICT_TASK_RE = re.compile(r"^TASK-[0-9]{3}[A-Z]?$")
ANY_TASK_TOKEN_RE = re.compile(r"\bTASK-[A-Za-z0-9]+\b")
GATE_TOKEN_RE = re.compile(r"\b[A-Z][A-Z0-9_]+_(?:VERIFIED|APPROVED|COMPLETED)\b")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def extract_strict_tasks(text, context):
    tokens = ANY_TASK_TOKEN_RE.findall(text)
    for token in tokens:
        require(STRICT_TASK_RE.match(token), f"Malformed task ID '{token}' in {context}")
    return tokens


def section_slice(text, start_heading, end_heading=None):
    start = text.find(start_heading)
    require(start != -1, f"Missing section {start_heading}")
    if end_heading is None:
        return text[start:]
    end = text.find(end_heading, start + len(start_heading))
    require(end != -1, f"Missing section {end_heading}")
    return text[start:end]


# 1. Parse all board tasks (L02 historical 174 + L03 active 90) with strict TASK-[0-9]{3}[A-Z]?
tasks = {}
l02_tasks = {}
l03_tasks = {}
in_section = None
for row in board.splitlines():
    if row.startswith("## L02"):
        in_section = "L02"
    elif row.startswith("## L03"):
        in_section = "L03"
    elif row.startswith("## "):
        in_section = None
    if not row.startswith("| TASK-"):
        continue
    cells = [cell.strip() for cell in row.strip("|").split("|")]
    task = cells[0].split()[0]
    require(STRICT_TASK_RE.match(task), f"Invalid task ID format: {task}")
    window = re.search(r"E(\d+)–E(\d+)$", cells[0])
    require(window and task not in tasks, f"Invalid task window or duplicate {task}")
    deps = extract_strict_tasks(cells[2], f"board {task} deps")
    require(task not in deps, f"Self dependency at {task}")
    entry = (int(window[1]), int(window[2]), deps)
    tasks[task] = entry
    if in_section == "L02":
        l02_tasks[task] = entry
    elif in_section == "L03":
        l03_tasks[task] = entry

require(len(l02_tasks) == 174, f"Expected 174 historical L02 tasks, found {len(l02_tasks)}")
require(len(l03_tasks) == 90, f"Expected 90 active L03 tasks, found {len(l03_tasks)}")

previous_end = 0
for task, (start, end, deps) in sorted(tasks.items(), key=lambda pair: pair[1][0]):
    require(start == previous_end + 1 and start <= end, f"Overlap or gap at {task}")
    for dep in deps:
        require(dep in tasks and tasks[dep][1] < start, f"{task} cannot start before {dep}")
    previous_end = end

# Explicit cycle detection over full board DAG
visiting, visited = set(), set()


def check_cycle(node, graph):
    visiting.add(node)
    for dep in graph[node]:
        require(dep in graph, f"Unknown dependency {dep} from {node}")
        require(dep not in visiting, f"Dependency cycle involving {node} -> {dep}")
        if dep not in visited:
            check_cycle(dep, graph)
    visiting.remove(node)
    visited.add(node)


board_graph = {t: info[2] for t, info in tasks.items()}
for t in board_graph:
    if t not in visited:
        check_cycle(t, board_graph)


def unique_ids(pattern, source):
    ids = re.findall(pattern, source, re.MULTILINE)
    require(len(set(ids)) == len(ids), f"Duplicate ID in {pattern}")
    return set(ids)


# 2. Validate PAGE, T, and AT IDs with strict A/B task references
pages = unique_ids(r"^\| (PAGE-[A-Z]\d+[a-z]?) ·", spec)
tests = unique_ids(r"^\| (T\d+) \|", spec)
gates = unique_ids(r"^\| (AT-\d+) \|", prd)

for row in prd.splitlines():
    if row.startswith("| AT-"):
        cells = [cell.strip() for cell in row.strip("|").split("|")]
        owner = re.search(r"(TASK-[0-9]{3}[A-Z]?) / (T[0-9]+) \|$", row)
        require(owner and owner[1] in tasks and owner[2] in tests, f"Unmapped gate: {row}")
        # Verify strict task tokens in col 3 (实施责任) and ensure main owner matches col 3 (no parent substitution)
        impl_match = re.search(r"实施责任：([^；]+)", cells[2])
        if impl_match:
            impl_tasks = extract_strict_tasks(impl_match.group(1), f"PRD {cells[0]} 实施责任")
            require(impl_tasks and all(t in tasks for t in impl_tasks), f"Unknown impl task in {cells[0]}")
            require(
                owner[1] in impl_tasks,
                f"AT owner drift at {cells[0]}: end-of-row '{owner[1]}' not in 实施责任 {impl_tasks}",
            )

for row in spec.splitlines():
    if re.match(r"^\| PAGE-\w+ ·", row):
        last_col = row.split("|")[-2]
        task_refs = extract_strict_tasks(last_col, f"Spec PAGE row {row[:30]}")
        legacy_d_refs = [f"TASK-{int(d):03}" for d in re.findall(r"\bD(\d+)\b", last_col)]
        all_refs = task_refs + legacy_d_refs
        require(all_refs and all(ref in tasks for ref in all_refs), f"Unscheduled page: {row}")

# 3. Validate K01 vs L03 exact parity (90 tasks, full A/B deps, E-windows, cycle-free, TASK-243 closure)
k01_text = section_slice(matrix, "## K01", "## K02")
k01_tasks = {}
for row in k01_text.splitlines():
    if not row.startswith("| TASK-"):
        continue
    cells = [cell.strip() for cell in row.strip("|").split("|")]
    tid = cells[0].split()[0]
    require(STRICT_TASK_RE.match(tid) and tid not in k01_tasks, f"Invalid or duplicate K01 task: {tid}")
    deps = extract_strict_tasks(cells[2], f"K01 {tid} deps")
    require(tid not in deps, f"K01 self dependency at {tid}")
    ewin = re.search(r"^E(\d+)–E(\d+)$", cells[6])
    require(ewin, f"Invalid K01 E-window at {tid}: {cells[6]}")
    k01_tasks[tid] = (int(ewin[1]), int(ewin[2]), deps)

require(
    set(k01_tasks) == set(l03_tasks),
    f"K01 vs L03 task set mismatch: {set(k01_tasks) ^ set(l03_tasks)}",
)
for tid, (ks, ke, kdeps) in k01_tasks.items():
    ls, le, ldeps = l03_tasks[tid]
    require((ks, ke) == (ls, le), f"K01 vs L03 E-window drift at {tid}: E{ks}–E{ke} != E{ls}–E{le}")
    require(set(kdeps) == set(ldeps), f"K01 vs L03 dependency drift at {tid}: {sorted(kdeps)} != {sorted(ldeps)}")

k01_graph = {t: info[2] for t, info in k01_tasks.items()}
k01_anc = {}


def ancestors(node):
    if node in k01_anc:
        return k01_anc[node]
    acc = set()
    for dep in k01_graph[node]:
        require(dep in k01_graph, f"K01 unknown dependency {dep} from {node}")
        acc.add(dep)
        acc |= ancestors(dep)
    k01_anc[node] = acc
    return acc


for tid in k01_graph:
    ancestors(tid)

require(
    (k01_anc["TASK-243"] | {"TASK-243"}) == set(k01_tasks),
    f"TASK-243 DAG closure misses: {sorted(set(k01_tasks) - k01_anc['TASK-243'] - {'TASK-243'})}",
)

# 4. Validate K03 67 production gates transitive closure + L04/K04 parity
k03_text = section_slice(matrix, "## K03", "## K04")
k03_gates = {}
for row in k03_text.splitlines():
    if not row.startswith("| ") or row.startswith("| ---") or row.startswith("| 门禁"):
        continue
    cells = [cell.strip() for cell in row.strip("|").split("|")]
    gate_name = cells[0]
    require(GATE_TOKEN_RE.fullmatch(gate_name) and gate_name not in k03_gates, f"Invalid or duplicate K03 gate: {gate_name}")
    evidence_tasks = extract_strict_tasks(cells[3], f"K03 {gate_name} evidence")
    signoff_tokens = extract_strict_tasks(cells[4], f"K03 {gate_name} signoff")
    require(len(signoff_tokens) == 1 and signoff_tokens[0] in k01_tasks, f"Invalid K03 signoff task at {gate_name}")
    signoff = signoff_tokens[0]
    require(evidence_tasks and all(t in k01_tasks for t in evidence_tasks), f"Unknown K03 evidence task at {gate_name}")
    closure = k01_anc[signoff] | {signoff}
    missing = [t for t in evidence_tasks if t not in closure]
    require(not missing, f"Premature K03 gate {gate_name} at {signoff}: evidence {missing} not in DAG closure")
    k03_gates[gate_name] = signoff

require(len(k03_gates) == 67, f"Expected 67 K03 production gates, found {len(k03_gates)}")

l04_text = section_slice(board, "## L04", "## L05")
l04_gates = {}
for row in l04_text.splitlines():
    m = re.match(r"^\|\s*([A-Z][A-Z0-9_]+_(?:VERIFIED|APPROVED|COMPLETED))\s*\|\s*([^|]+)\s*\|", row)
    if not m:
        continue
    gate_name = m.group(1)
    owner_tokens = extract_strict_tasks(m.group(2), f"L04 {gate_name}")
    require(len(owner_tokens) == 1 and gate_name not in l04_gates, f"Invalid or duplicate L04 gate: {gate_name}")
    l04_gates[gate_name] = owner_tokens[0]

require(
    l04_gates == k03_gates,
    f"K03 vs L04 gate owner drift: {[(g, k03_gates.get(g), l04_gates.get(g)) for g in sorted(set(k03_gates) | set(l04_gates)) if k03_gates.get(g) != l04_gates.get(g)]}",
)

k04_text = section_slice(matrix, "## K04", "## K05")
k04_gate_owners = {}
for row in k04_text.splitlines():
    if not row.startswith("| TASK-"):
        continue
    cells = [cell.strip() for cell in row.strip("|").split("|")]
    tid = cells[0].split()[0]
    require(STRICT_TASK_RE.match(tid) and tid in k01_tasks, f"Invalid K04 task: {tid}")
    for gate_name in GATE_TOKEN_RE.findall(cells[4]):
        require(gate_name not in k04_gate_owners, f"Duplicate K04 gate assignment: {gate_name}")
        k04_gate_owners[gate_name] = tid

require(
    k04_gate_owners == k03_gates,
    f"K03 vs K04 gate owner drift: {[(g, k03_gates.get(g), k04_gate_owners.get(g)) for g in sorted(set(k03_gates) | set(k04_gate_owners)) if k03_gates.get(g) != k04_gate_owners.get(g)]}",
)

# 5. Relative link integrity across docs/*.md and AGENTS.md
for file in [*DOCS.glob("*.md"), DOCS.parent / "AGENTS.md"]:
    for target in re.findall(r"\]\(([^ )]+)\)", file.read_text()):
        # Historical visual evidence lives in the author's local Codex workspace.
        if re.match(r"^/Users/[^/]+/\.codex/visualizations/", target):
            continue
        if not target.startswith(("https://", "http://", "#")):
            require((file.parent / target.split("#")[0]).exists(), f"Broken link: {target}")

# 6. OpenAPI schema & transaction invariants
schemas = contract["components"]["schemas"]


def resolve(node):
    if isinstance(node, list):
        return [resolve(value) for value in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        name = node["$ref"].removeprefix("#/components/schemas/")
        return resolve(schemas[name])
    return {key: resolve(value) for key, value in node.items()}


ops = set()
for path, methods in contract["paths"].items():
    for op in methods.values():
        name = op["operationId"]
        require(name not in ops and op["x-roles"], f"Invalid operation: {name}")
        ops.add(name)
        params = {p["name"] for p in op["parameters"] if p["in"] == "path" and p["required"]}
        require(params == set(re.findall(r"{(\w+)}", path)), f"Invalid parameters: {path}")
        for entry in [op.get("requestBody", {}), *op["responses"].values()]:
            for media in entry.get("content", {}).values():
                Draft202012Validator.check_schema(resolve(media["schema"]))

result = Draft202012Validator(resolve(schemas["Result"]))
base = {"component": "main", "item_key": "width", "method": "ruler", "attempt": 1, "is_final": True}
require(result.is_valid(dict(base, status="RECORDED", typed_value=0)), "Measured zero lost")
require(not result.is_valid(dict(base, status="RECORDED")), "Missing value accepted")
require(not result.is_valid(dict(base, status="NOT_TESTED", reason="Unavailable", typed_value=0)), "Missing measurement became zero")
entry = contract["paths"]["/me/items/{id}/dispositions"]["post"]["requestBody"]["content"]["application/json"]["schema"]
instruction = Draft202012Validator(resolve(entry))
request = {
    "action": "return_to_seller",
    "terms_version_id": "00000000-0000-4000-8000-000000000001",
    "destination": {"recipient": "Seller", "phone": "test", "address": "Test destination"},
}
require(not instruction.is_valid(request), "Return without customer confirmation accepted")
request["return_info"] = {"requested_from_seller": True, "customer_pays_shipping": True}
require(instruction.is_valid(request), "Valid return without outbound number rejected")
print(
    f"{len(tasks)} tasks ({len(l02_tasks)} historical + {len(l03_tasks)} active), E1–E{previous_end}, "
    f"{len(pages)} pages, {len(tests)} implementation cases, {len(gates)} AT groups, "
    f"{len(k03_gates)} production gates, {len(ops)} transaction operations"
)
