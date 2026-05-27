#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

import click

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = "decx_agent"

from .core.agent import DecxAgent
from .core.config import load_agent_config
from .core.store import load_project
from .workers import create_driver, supported_workers


def emit(payload: object, *, pretty: bool) -> None:
    click.echo(json.dumps(payload, indent=2 if pretty else None, ensure_ascii=True))


class CliState:
    def __init__(self, *, project_root: str, worker: str, model: str | None, artifact_root: str, config: str | None, compact_json: bool):
        self.project_root = Path(project_root).resolve()
        self.worker = worker
        self.model = model
        self.artifact_root = artifact_root
        self.config = config
        self.pretty = not compact_json

    def agent(self) -> DecxAgent:
        return DecxAgent(
            project_root=self.project_root,
            worker=create_driver(self.worker, model=self.model),
            artifact_root=self.artifact_root,
            config=load_agent_config(self.project_root, self.config),
        )


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
@click.option("--project-root", default=".", show_default=True, help="repository root")
@click.option("--worker", default="noop", show_default=True, type=click.Choice(supported_workers()), help="worker backend")
@click.option("--model", default=None, help="worker model name when supported")
@click.option("--artifact-root", default=".decx-analysis", show_default=True, help="run-state directory")
@click.option("--config", default=None, help="agent JSON config path")
@click.option("--json", "compact_json", is_flag=True, help="emit compact JSON")
@click.pass_context
def cli(ctx: click.Context, project_root: str, worker: str, model: str | None, artifact_root: str, config: str | None, compact_json: bool) -> None:
    """DECX fact/intent exploration agent."""
    ctx.obj = CliState(
        project_root=project_root,
        worker=worker,
        model=model,
        artifact_root=artifact_root,
        config=config,
        compact_json=compact_json,
    )


@cli.command("run")
@click.argument("target")
@click.option("--mode", default=None)
@click.option("--port", type=int, default=None)
@click.option("--dry-run", is_flag=True)
@click.option("--max-steps", type=int, default=8, show_default=True)
@click.pass_obj
def run_command(state: CliState, target: str, mode: str | None, port: int | None, dry_run: bool, max_steps: int) -> None:
    """Run a configured DECX agent task."""
    run_agent_task(state, target=target, mode=mode, port=port, dry_run=dry_run, max_steps=max_steps)


def run_agent_task(state: CliState, *, target: str, mode: str | None, port: int | None, dry_run: bool, max_steps: int) -> None:
    project, results = state.agent().run_target(
        target=target,
        mode=mode,
        port=port,
        dry_run=dry_run,
        max_steps=max_steps,
    )
    emit_run(project, results, pretty=state.pretty)


@cli.command("analyze", hidden=True)
@click.argument("target")
@click.option("--mode", default=None)
@click.option("--port", type=int, default=None)
@click.option("--dry-run", is_flag=True)
@click.option("--max-steps", type=int, default=8, show_default=True)
@click.pass_obj
def analyze_alias(state: CliState, target: str, mode: str | None, port: int | None, dry_run: bool, max_steps: int) -> None:
    """Compatibility alias for run."""
    run_agent_task(state, target=target, mode=mode, port=port, dry_run=dry_run, max_steps=max_steps)


@cli.command()
@click.argument("run_path")
@click.option("--dry-run", is_flag=True)
@click.option("--max-steps", type=int, default=8, show_default=True)
@click.pass_obj
def resume(state: CliState, run_path: str, dry_run: bool, max_steps: int) -> None:
    """Resume an existing run.json or artifact directory."""
    project, results = state.agent().resume(run_path=run_path, dry_run=dry_run, max_steps=max_steps)
    emit_run(project, results, pretty=state.pretty)


@cli.command()
@click.argument("run_path")
@click.pass_obj
def status(state: CliState, run_path: str) -> None:
    """Read run state."""
    emit(load_project(run_path).to_dict(), pretty=state.pretty)


@cli.command()
@click.argument("run_path")
@click.argument("content")
@click.option("--creator", default="user", show_default=True)
@click.pass_obj
def hint(state: CliState, run_path: str, content: str, creator: str) -> None:
    """Append a human hint to the board."""
    project = state.agent().add_hint(run_path=run_path, content=content, creator=creator)
    emit(project.to_dict(), pretty=state.pretty)


@cli.command()
@click.pass_obj
def workers(state: CliState) -> None:
    """List worker backends."""
    emit({"workers": supported_workers()}, pretty=state.pretty)


def emit_run(project: object, results: list[object], *, pretty: bool) -> None:
    emit({"state": project.to_dict(), "results": [result.to_dict() for result in results]}, pretty=pretty)


def main(argv: list[str] | None = None) -> int:
    try:
        cli.main(args=argv, prog_name="decx-agent", standalone_mode=False)
        return 0
    except click.ClickException as exc:
        exc.show()
        return exc.exit_code
    except click.Abort:
        click.echo("Aborted!", err=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
