import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../../services/bridge_service.dart';
import '../../theme/app_spacing.dart';
import '../../theme/app_theme.dart';
import '../../theme/markdown_style.dart';
import '../../utils/tool_categories.dart';

/// Fork: live view of a subagent's transcript (Agent/Task tool), like the
/// subagent view of the Claude Code CLI.
///
/// The bridge serves `<session>/subagents/agent-<id>.jsonl` on
/// `GET /api/subagent`; the screen asks for new entries only (`after`) every
/// second while the subagent runs and every few seconds once it stopped.
class SubagentScreen extends StatefulWidget {
  /// Bridge or Claude session id of the parent session.
  final String sessionId;
  final String? toolUseId;
  final String? agentId;

  /// Shown until the bridge answers (the Agent tool's description).
  final String? initialTitle;

  const SubagentScreen({
    super.key,
    required this.sessionId,
    this.toolUseId,
    this.agentId,
    this.initialTitle,
  });

  static Future<void> open(
    BuildContext context, {
    required String sessionId,
    String? toolUseId,
    String? agentId,
    String? title,
  }) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SubagentScreen(
          sessionId: sessionId,
          toolUseId: toolUseId,
          agentId: agentId,
          initialTitle: title,
        ),
      ),
    );
  }

  @override
  State<SubagentScreen> createState() => _SubagentScreenState();
}

class _SubagentScreenState extends State<SubagentScreen> {
  static const _livePoll = Duration(seconds: 1);
  static const _idlePoll = Duration(seconds: 8);

  final _scroll = ScrollController();
  Timer? _poll;
  Timer? _clock;
  bool _loading = true;
  bool _inFlight = false;
  int _status = 0;
  Map<String, dynamic>? _agent;
  List<Map<String, dynamic>> _siblings = const [];
  final List<Map<String, dynamic>> _entries = [];
  int _total = 0;
  bool _truncated = false;
  String? _agentId;

  @override
  void initState() {
    super.initState();
    _agentId = widget.agentId;
    _load();
    // Re-render "updated Ns ago" in the activity line.
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _state == 'running') setState(() {});
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _clock?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  String? get _state => _agent?['state'] as String?;

  Future<void> _load({bool full = false}) async {
    if (_inFlight) return;
    _inFlight = true;
    _poll?.cancel();
    final bridge = context.read<BridgeService>();
    final incremental = !full && _total > 0;
    final result = await bridge.fetchSubagentHistory(
      session: widget.sessionId,
      toolUseId: _agentId == null ? widget.toolUseId : null,
      agentId: _agentId,
      after: incremental ? _total : null,
    );
    _inFlight = false;
    if (!mounted) return;

    final body = result.body;
    final total = (body?['total'] as num?)?.toInt();
    if (incremental && total != null && total < _total) {
      // Transcript was rewritten (e.g. compacted): start over.
      _total = 0;
      _load(full: true);
      return;
    }
    final fresh =
        (body?['entries'] as List?)
            ?.whereType<Map<String, dynamic>>()
            .toList() ??
        const <Map<String, dynamic>>[];
    final wasAtBottom =
        !_scroll.hasClients ||
        _scroll.position.pixels >= _scroll.position.maxScrollExtent - 48;

    setState(() {
      _loading = false;
      _status = result.status;
      if (body != null) {
        _agent = body['agent'] as Map<String, dynamic>?;
        _agentId ??= _agent?['agentId'] as String?;
        _siblings =
            (body['siblings'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .toList() ??
            const [];
        if (!incremental) {
          _entries.clear();
          _truncated = body['truncated'] == true;
        }
        _entries.addAll(fresh);
        _total = total ?? _entries.length;
      }
    });

    if (fresh.isNotEmpty && wasAtBottom) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) {
          _scroll.jumpTo(_scroll.position.maxScrollExtent);
        }
      });
    }
    final live = _state == 'running' || result.status == 404;
    _poll = Timer(live ? _livePoll : _idlePoll, _load);
  }

  void _switchTo(String agentId) {
    setState(() {
      _agentId = agentId;
      _agent = null;
      _entries.clear();
      _total = 0;
      _loading = true;
    });
    _load(full: true);
  }

  String get _title {
    final a = _agent;
    final desc = a?['description'] as String?;
    if (desc != null && desc.isNotEmpty) return desc;
    final type = a?['agentType'] as String?;
    if (type != null && type.isNotEmpty) return type;
    return widget.initialTitle ?? 'Subagent';
  }

  @override
  Widget build(BuildContext context) {
    final appColors = Theme.of(context).extension<AppColors>()!;
    final type = _agent?['agentType'] as String?;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_title, overflow: TextOverflow.ellipsis),
            Row(
              children: [
                if (_state != null) ...[
                  SubagentStateDot(state: _state!),
                  const SizedBox(width: 6),
                  Text(
                    subagentStateLabel(_state!),
                    style: TextStyle(fontSize: 12, color: appColors.subtleText),
                  ),
                ],
                if (type != null && type.isNotEmpty)
                  Flexible(
                    child: Text(
                      '${_state != null ? '  ·  ' : ''}$type',
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: appColors.subtleText,
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
        actions: [
          if (_siblings.isNotEmpty)
            PopupMenuButton<String>(
              tooltip: 'Other subagents',
              icon: const Icon(Icons.account_tree_outlined),
              onSelected: _switchTo,
              itemBuilder: (_) => [
                for (final s in _siblings)
                  if (s['agentId'] is String)
                    PopupMenuItem(
                      value: s['agentId'] as String,
                      child: Row(
                        children: [
                          SubagentStateDot(
                            state: s['state'] as String? ?? 'done',
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              subagentTitle(s),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                    ),
              ],
            ),
        ],
      ),
      body: Column(
        children: [
          Expanded(child: _buildBody(appColors)),
          if (_state == 'running') _buildActivityLine(appColors),
        ],
      ),
    );
  }

  /// Terminal-like "✻ Running Bash · updated 3s ago" line.
  Widget _buildActivityLine(AppColors appColors) {
    final answered = <String>{
      for (final e in _entries)
        if (e['kind'] == 'tool_result') e['toolUseId'] as String? ?? '',
    };
    Map<String, dynamic>? pending;
    for (final e in _entries.reversed) {
      if (e['kind'] == 'tool_use') {
        if (!answered.contains(e['id'])) pending = e;
        break;
      }
      if (e['kind'] == 'text' || e['kind'] == 'thinking') break;
    }
    String activity;
    if (pending != null) {
      final name = pending['name'] as String? ?? 'tool';
      final summary = getToolSummary(
        categorizeToolName(name),
        (pending['input'] as Map?)?.cast<String, dynamic>() ?? const {},
      );
      activity = summary.isEmpty ? 'Running $name' : 'Running $name · $summary';
    } else {
      activity = 'Thinking…';
    }
    final updatedAt = (_agent?['updatedAt'] as num?)?.toInt();
    final ago = updatedAt == null
        ? ''
        : formatAgo(
            DateTime.now().difference(
              DateTime.fromMillisecondsSinceEpoch(updatedAt),
            ),
          );
    final color = Theme.of(context).colorScheme.primary;
    return SafeArea(
      top: false,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: appColors.toolBubbleBorder)),
        ),
        child: Row(
          children: [
            Text('✻', style: TextStyle(color: color, fontSize: 13)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                activity,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
              ),
            ),
            if (ago.isNotEmpty)
              Text(
                'updated $ago',
                style: TextStyle(
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: appColors.subtleText,
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(AppColors appColors) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_entries.isEmpty) {
      final text = switch (_status) {
        0 => 'Bridge is unreachable. Retrying…',
        404 =>
          'No transcript for this subagent yet. It appears once the subagent '
              'starts; if it never does, the bridge may be too old.',
        200 => 'The subagent has not written anything yet.',
        _ => 'Bridge answered with HTTP $_status.',
      };
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            text,
            textAlign: TextAlign.center,
            style: TextStyle(color: appColors.subtleText),
          ),
        ),
      );
    }

    final results = <String, Map<String, dynamic>>{
      for (final e in _entries)
        if (e['kind'] == 'tool_result' && e['toolUseId'] is String)
          e['toolUseId'] as String: e,
    };
    final visible = _entries.where((e) => e['kind'] != 'tool_result').toList();
    final running = _state == 'running';

    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: visible.length + (_truncated ? 1 : 0),
      itemBuilder: (context, index) {
        if (_truncated) {
          if (index == 0) {
            return Padding(
              padding: const EdgeInsets.all(8),
              child: Text(
                'Older steps are hidden; showing the latest ones.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: appColors.subtleText),
              ),
            );
          }
          index -= 1;
        }
        final e = visible[index];
        return switch (e['kind']) {
          'text' => _SubagentText(
            text: e['text'] as String? ?? '',
            isUser: e['role'] == 'user',
          ),
          'thinking' => _SubagentThinking(text: e['text'] as String? ?? ''),
          'tool_use' => _SubagentToolCall(
            key: ValueKey('subagent_tool_${e['id']}'),
            name: e['name'] as String? ?? 'tool',
            input:
                (e['input'] as Map?)?.cast<String, dynamic>() ??
                const <String, dynamic>{},
            result: results[e['id']],
            running: running,
          ),
          _ => const SizedBox.shrink(),
        };
      },
    );
  }
}

/// "3s", "2m", "1h" for the activity line.
String formatAgo(Duration d) {
  if (d.inSeconds < 60) return '${d.inSeconds.clamp(0, 59)}s ago';
  if (d.inMinutes < 60) return '${d.inMinutes}m ago';
  return '${d.inHours}h ago';
}

String subagentTitle(Map<String, dynamic> agent) {
  final desc = agent['description'] as String?;
  if (desc != null && desc.isNotEmpty) return desc;
  final type = agent['agentType'] as String?;
  if (type != null && type.isNotEmpty) return type;
  return agent['agentId'] as String? ?? 'Subagent';
}

String subagentStateLabel(String state) => switch (state) {
  'running' => 'Running',
  'done' => 'Done',
  'failed' => 'Failed',
  'interrupted' => 'Interrupted',
  _ => state,
};

/// Small coloured dot for a subagent state; pulses while running.
class SubagentStateDot extends StatefulWidget {
  final String state;

  const SubagentStateDot({super.key, required this.state});

  @override
  State<SubagentStateDot> createState() => _SubagentStateDotState();
}

class _SubagentStateDotState extends State<SubagentStateDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(covariant SubagentStateDot oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  void _sync() {
    if (widget.state == 'running') {
      if (!_pulse.isAnimating) _pulse.repeat(reverse: true);
    } else {
      _pulse.stop();
      _pulse.value = 1;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final appColors = Theme.of(context).extension<AppColors>()!;
    final color = switch (widget.state) {
      'running' => appColors.statusRunning,
      'done' => appColors.statusIdle,
      'failed' => appColors.errorText,
      _ => appColors.subtleText,
    };
    return FadeTransition(
      opacity: Tween<double>(begin: 0.35, end: 1).animate(_pulse),
      child: Container(
        width: 8,
        height: 8,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      ),
    );
  }
}

class _SubagentText extends StatelessWidget {
  final String text;
  final bool isUser;

  const _SubagentText({required this.text, required this.isUser});

  @override
  Widget build(BuildContext context) {
    final appColors = Theme.of(context).extension<AppColors>()!;
    return Container(
      margin: const EdgeInsets.symmetric(
        horizontal: AppSpacing.bubbleMarginH,
        vertical: 4,
      ),
      padding: const EdgeInsets.all(10),
      decoration: isUser
          ? BoxDecoration(
              color: appColors.toolBubble,
              borderRadius: BorderRadius.circular(AppSpacing.cardRadius),
              border: Border.all(color: appColors.toolBubbleBorder),
            )
          : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (isUser)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                'Task',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: appColors.subtleText,
                ),
              ),
            ),
          MarkdownBody(
            data: text,
            selectable: true,
            styleSheet: buildMarkdownStyle(context),
          ),
        ],
      ),
    );
  }
}

/// Collapsed "∴ Thinking" line, like the CLI; tap to read.
class _SubagentThinking extends StatefulWidget {
  final String text;

  const _SubagentThinking({required this.text});

  @override
  State<_SubagentThinking> createState() => _SubagentThinkingState();
}

class _SubagentThinkingState extends State<_SubagentThinking> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final appColors = Theme.of(context).extension<AppColors>()!;
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.bubbleMarginH,
        vertical: 1,
      ),
      child: InkWell(
        onTap: () => setState(() => _expanded = !_expanded),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 2),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '∴ Thinking',
                style: TextStyle(
                  fontSize: 12,
                  fontStyle: FontStyle.italic,
                  color: appColors.subtleText,
                ),
              ),
              if (_expanded)
                Padding(
                  padding: const EdgeInsets.only(top: 4, left: 14),
                  child: SelectableText(
                    widget.text,
                    style: TextStyle(
                      fontSize: 12,
                      fontStyle: FontStyle.italic,
                      color: appColors.subtleText,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SubagentToolCall extends StatefulWidget {
  final String name;
  final Map<String, dynamic> input;
  final Map<String, dynamic>? result;

  /// False once the subagent stopped: a call without result was cut off.
  final bool running;

  const _SubagentToolCall({
    super.key,
    required this.name,
    required this.input,
    required this.result,
    required this.running,
  });

  @override
  State<_SubagentToolCall> createState() => _SubagentToolCallState();
}

class _SubagentToolCallState extends State<_SubagentToolCall> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final appColors = Theme.of(context).extension<AppColors>()!;
    final category = categorizeToolName(widget.name);
    final result = widget.result;
    final isError = result?['isError'] == true;
    final pending = result == null;
    final mono = TextStyle(
      fontSize: 11,
      fontFamily: 'monospace',
      height: 1.4,
      color: appColors.toolResultTextExpanded,
    );

    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.bubbleMarginH,
        vertical: 1,
      ),
      child: InkWell(
        onTap: () => setState(() => _expanded = !_expanded),
        borderRadius: BorderRadius.circular(AppSpacing.cardRadius),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 2),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    getToolCategoryIcon(category),
                    size: 12,
                    color: getToolCategoryColor(category, appColors),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    widget.name,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      getToolSummary(category, widget.input),
                      style: TextStyle(
                        fontSize: 11,
                        color: appColors.subtleText,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (pending && widget.running)
                    const SizedBox(
                      width: 10,
                      height: 10,
                      child: CircularProgressIndicator(strokeWidth: 1.5),
                    )
                  else if (isError)
                    Icon(
                      Icons.error_outline,
                      size: 14,
                      color: appColors.errorText,
                    ),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 14,
                    color: appColors.subtleText,
                  ),
                ],
              ),
              if (_expanded) ...[
                const SizedBox(height: 6),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: appColors.toolResultBackground,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SelectableText(_inputText(category), style: mono),
                      if (result != null) ...[
                        const Divider(height: 16),
                        SelectableText(
                          (result['content'] as String?)?.trim().isNotEmpty ==
                                  true
                              ? (result['content'] as String).trim()
                              : '(no output)',
                          style: isError
                              ? mono.copyWith(color: appColors.errorText)
                              : mono,
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  String _inputText(ToolCategory category) {
    final text = getToolFullInput(category, widget.input);
    if (text.trim().isNotEmpty) return text;
    return const JsonEncoder.withIndent('  ').convert(widget.input);
  }
}
