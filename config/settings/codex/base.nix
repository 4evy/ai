{
  model = "gpt-6.1-sol";
  model_reasoning_effort = "high";
  plan_mode_reasoning_effort = "high";
  approval_policy = "never";
  default_permissions = ":danger-full-access";
  web_search = "live";
  check_for_update_on_startup = false;
  suppress_unstable_features_warning = true;
  tool_output_token_limit = 32768;
  project_doc_max_bytes = 65536;
  project_root_markers = [
    ".git"
    ".jj"
  ];
  tui = {
    notification_condition = "always";
    show_tooltips = false;
    question_esc_back = true;
    terminal_resize_reflow_max_rows = 0;
    status_line = [
      "model-with-reasoning"
      "project-name"
      "context-remaining"
      "five-hour-limit"
      "weekly-limit"
    ];
    keymap = {
      global = {
        open_external_editor = "ctrl-x";
      };
      composer = {
        queue = "ctrl-shift-enter";
      };
    };
  };
  mcp_servers = {
    ghidra = {
      startup_timeout_sec = 60;
      tool_timeout_sec = 1800;
      default_tools_approval_mode = "approve";
    };
  };
  features = {
    prevent_idle_sleep = true;
    multi_agent_v2 = true;
    default_mode_request_user_input = true;
    code_mode = {
      enabled = true;
      default_exec_yield_time_ms = 10000;
    };
  };
  tools = {
    update_plan = {
      enabled = true;
    };
  };
  apps = {
    _default = {
      enabled = true;
      destructive_enabled = true;
      open_world_enabled = true;
      default_tools_approval_mode = "approve";
    };
  };
  notice = {
    hide_full_access_warning = true;
  };
  desktop = {
    followUpQueueMode = "queue";
    preventSleepWhileRunning = true;
  };
}
