"""CI regression test suite for docs/contracts/check.py enforcing L07.1 contract rules."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parents[1]


class ContractCheckerRegressionTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.work = Path(self._tmp.name) / "repo"
        shutil.copytree(REPO_ROOT / "docs", self.work / "docs")
        for entry in REPO_ROOT.iterdir():
            if entry.name in ("docs", ".git", "node_modules", ".next"):
                continue
            (self.work / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
        self.checker = self.work / "docs/contracts/check.py"

    def tearDown(self):
        self._tmp.cleanup()

    def run_checker(self):
        return subprocess.run(
            [sys.executable, str(self.checker)],
            capture_output=True,
            text=True,
            cwd=str(self.work),
        )

    def assert_rejected(self, rel_path, transform, expected_fragment=None):
        target = self.work / rel_path
        original = target.read_text()
        updated = transform(original)
        self.assertNotEqual(updated, original, f"Mutation did not change {rel_path}")
        target.write_text(updated)
        res = self.run_checker()
        self.assertNotEqual(res.returncode, 0, f"Checker unexpectedly passed after mutating {rel_path}")
        if expected_fragment:
            combined = res.stdout + "\n" + res.stderr
            self.assertIn(expected_fragment, combined)

    def test_positive_baseline_passes(self):
        res = self.run_checker()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn(
            "264 tasks (174 historical + 90 active), E1–E654, 121 pages, 147 implementation cases, 82 AT groups, 67 production gates, 51 transaction operations",
            res.stdout,
        )

    def test_01_rejects_unknown_subtask_dependency(self):
        def mutate(s):
            lines = []
            replaced = False
            for line in s.splitlines():
                if line.startswith("| TASK-176 "):
                    cols = line.split("|")
                    cols[3] = " TASK-175, TASK-207Z "
                    line = "|".join(cols)
                    replaced = True
                lines.append(line)
            assert replaced
            return "\n".join(lines) + "\n"

        self.assert_rejected("docs/开发排期与任务台账.md", mutate, "TASK-207Z")

    def test_02_rejects_malformed_subtask_suffix(self):
        self.assert_rejected(
            "docs/开发排期与任务台账.md",
            lambda s: s.replace("| TASK-176 / PKG-0 · E243–E248 |", "| TASK-207AA / PKG-0 · E243–E248 |", 1),
            "TASK-207AA",
        )

    def test_03_rejects_missing_board_subtask_task_207a(self):
        self.assert_rejected(
            "docs/开发排期与任务台账.md",
            lambda s: "\n".join(line for line in s.splitlines() if not line.startswith("| TASK-207A ")),
            "Expected 90 active L03 tasks",
        )

    def test_04_rejects_replacing_subtask_dep_with_parent(self):
        def mutate(s):
            lines = []
            replaced = False
            for line in s.splitlines():
                if line.startswith("| TASK-207 ") and "TASK-207A" in line:
                    line = line.replace("TASK-207A", "TASK-207", 1)
                    replaced = True
                lines.append(line)
            assert replaced
            return "\n".join(lines) + "\n"

        self.assert_rejected("docs/开发排期与任务台账.md", mutate)

    def test_05_rejects_at17_owner_substitution_to_parent(self):
        def mutate(s):
            lines = []
            replaced = False
            for line in s.splitlines():
                if line.startswith("| AT-17 |"):
                    assert line.endswith("TASK-207A / T07 |")
                    line = line[: -len("TASK-207A / T07 |")] + "TASK-207 / T07 |"
                    replaced = True
                lines.append(line)
            assert replaced
            return "\n".join(lines) + "\n"

        self.assert_rejected("docs/QCWarehouse_PRD_v3_MultiCategory.md", mutate, "AT owner drift at AT-17")

    def test_06_rejects_page_pointing_to_unknown_subtask(self):
        def mutate(s):
            lines = []
            replaced = False
            for line in s.splitlines():
                if line.startswith("| PAGE-") and "TASK-207A" in line:
                    line = line.replace("TASK-207A", "TASK-207Z", 1)
                    replaced = True
                    lines.append(line)
                    continue
                lines.append(line)
            assert replaced
            return "\n".join(lines) + "\n"

        self.assert_rejected("docs/开发规格.md", mutate, "Unscheduled page")

    def test_07_rejects_k01_vs_l03_dependency_drift(self):
        def mutate(s):
            lines = []
            replaced = False
            for line in s.splitlines():
                if line.startswith("| TASK-177 |"):
                    line = line.replace("TASK-175, TASK-176", "TASK-175", 1)
                    replaced = True
                lines.append(line)
            assert replaced
            return "\n".join(lines) + "\n"

        self.assert_rejected("docs/生产级统一重构分包排期与需求追踪矩阵.md", mutate, "K01 vs L03 dependency drift at TASK-177")

    def test_08_rejects_k01_vs_l03_ewindow_drift(self):
        def mutate(s):
            lines = []
            replaced = False
            for line in s.splitlines():
                if line.startswith("| TASK-177 |"):
                    line = line.replace("| E256–E258 |", "| E256–E259 |", 1)
                    replaced = True
                lines.append(line)
            assert replaced
            return "\n".join(lines) + "\n"

        self.assert_rejected("docs/生产级统一重构分包排期与需求追踪矩阵.md", mutate, "K01 vs L03 E-window drift at TASK-177")

    def test_09_rejects_duplicate_task_on_board(self):
        self.assert_rejected(
            "docs/开发排期与任务台账.md",
            lambda s: s.replace("| TASK-189A ", "| TASK-176 ", 1),
            "Invalid task window or duplicate TASK-176",
        )

    def test_10_rejects_ewindow_gap_on_board(self):
        self.assert_rejected(
            "docs/开发排期与任务台账.md",
            lambda s: s.replace("E243–E248 |", "E244–E248 |", 1),
            "Overlap or gap at TASK-176",
        )

    def test_11_rejects_dependency_inversion_or_cycle(self):
        def mutate(s):
            lines = []
            replaced = False
            for line in s.splitlines():
                if line.startswith("| TASK-175 /"):
                    cols = line.split("|")
                    cols[3] = " TASK-176 "
                    line = "|".join(cols)
                    replaced = True
                lines.append(line)
            assert replaced
            return "\n".join(lines) + "\n"

        self.assert_rejected("docs/开发排期与任务台账.md", mutate, "TASK-175 cannot start before TASK-176")

    def test_12_rejects_premature_k03_gate_signoff(self):
        def mutate(s):
            lines = []
            replaced = False
            for line in s.splitlines():
                if line.startswith("| INSTRUCTION_EXECUTION_TRACE_VERIFIED |"):
                    line = line.replace("| TASK-243 |", "| TASK-176 |", 1)
                    replaced = True
                lines.append(line)
            assert replaced
            return "\n".join(lines) + "\n"

        self.assert_rejected("docs/生产级统一重构分包排期与需求追踪矩阵.md", mutate, "Premature K03 gate INSTRUCTION_EXECUTION_TRACE_VERIFIED")

    def test_13_rejects_k04_l04_gate_owner_drift(self):
        def mutate(s):
            lines = []
            replaced = False
            for line in s.splitlines():
                if line.startswith("| BUSINESS_APPROVED |"):
                    line = line.replace("| TASK-197B |", "| TASK-242 |", 1)
                    replaced = True
                lines.append(line)
            assert replaced
            return "\n".join(lines) + "\n"

        self.assert_rejected("docs/开发排期与任务台账.md", mutate, "K03 vs L04 gate owner drift")

    def test_14_preserves_relative_link_check(self):
        self.assert_rejected(
            "docs/开发排期与任务台账.md",
            lambda s: s + "\n[broken](audits/does-not-exist.md)\n",
            "Broken link",
        )

    def test_15_preserves_openapi_business_invariant_check(self):
        self.assert_rejected(
            "docs/contracts/core.openapi.yaml",
            lambda s: s.replace("                  required:\n                  - return_info", "                  required: []"),
            "Return without customer confirmation accepted",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
