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

/// Fork: read-only view of a subagent's transcript (Agent/Task tool).
///
/// The bridge reads `<session>/subagents/agent-<id>.jsonl` and serves it on
/// `GET /api/subagent`; the screen polls it while open, faster while the
/// transcript keeps growing.
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
  static const _fastPoll = Duration(seconds: 3);
  static const _slowPoll = Duration(seconds: 15);

  final _scroll = ScrollController();
  Timer? _timer;
  bool _loading = true;
  bool _inFlight = false;
  int _status = 0;
  Map<String, dynamic>? _agent;
  List<Map<String, dynamic>> _siblings = const [];
  List<Map<String, dynamic>> _entries = const [];
  bool _truncated = false;
  int _unchangedPolls = 0;
  String? _agentId;

  @override
  void initState() {
    super.initState();
    _agentId = widget.agentId;
    _load();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (_inFlight) return;
    _inFlight = true;
    _timer?.cancel();
    final bridge = context.read<BridgeService>();
    final result = await bridge.fetchSubagentHistory(
      session: widget.sessionId,
      toolUseId: _agentId == null ? widget.toolUseId : null,
      agentId: _agentId,
    );
    _inFlight = false;
    if (!mounted) return;

    final body = result.body;
    final entries = (body?['entries'] as List?)
            ?.whereType<Map<String, dynamic>>()
            .toList() ??
        const <Map<String, dynamic>>[];
    final grew = entries.length != _entries.length;
    final wasAtBottom = !_scroll.hasClients ||
        _scroll.position.pixels >= _scroll.position.maxScrollExtent - 48;

    setState(() {
      _loading = false;
      _status = result.status;
      if (body != null) {
        _agent = body['agent'] as Map<String, dynamic>?;
        _agentId ??= _agent?['agentId'] as String?;
        _siblings = (body['siblings'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .toList() ??
            const [];
        _entries = entries;
        _truncated = body['truncated'] == true;
      }
      _unchangedPolls = grew ? 0 : _unchangedPolls + 1;
    });

    if (grew && wasAtBottom) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) {
          _scroll.jumpTo(_scroll.position.maxScrollExtent);
        }
      });
    }
    // Poll fast while the transcript grows (or does not exist yet), then
    // back off once it has been quiet for ~30 s.
    final delay = _unchangedPolls > 10 ? _slowPoll : _fastPoll;
    _timer = Timer(delay, _load);
  }

  void _switchTo(String agentId) {
    setState(() {
      _agentId = agentId;
      _agent = null;
      _entries = const [];
      _loading = true;
      _unchangedPolls = 0;
    });
    _load();
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
            if (type != null && type.isNotEmpty)
              Text(
                type,
                style: TextStyle(fontSize: 12, color: appColors.subtleText),
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
                      child: Text(
                        (s['description'] as String?)?.isNotEmpty == true
                            ? s['description'] as String
                            : (s['agentType'] as String?) ??
                                  s['agentId'] as String,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
              ],
            ),
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: () {
              _unchangedPolls = 0;
              _load();
            },
          ),
        ],
      ),
      body: _buildBody(appColors),
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
          'tool_use' => _SubagentToolCall(
            key: ValueKey('subagent_tool_${e['id']}'),
            name: e['name'] as String? ?? 'tool',
            input:
                (e['input'] as Map?)?.cast<String, dynamic>() ??
                const <String, dynamic>{},
            result: results[e['id']],
          ),
          _ => const SizedBox.shrink(),
        };
      },
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

class _SubagentToolCall extends StatefulWidget {
  final String name;
  final Map<String, dynamic> input;
  final Map<String, dynamic>? result;

  const _SubagentToolCall({
    super.key,
    required this.name,
    required this.input,
    required this.result,
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
                  if (pending)
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
                      SelectableText(
                        _inputText(category),
                        style: mono,
                      ),
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
