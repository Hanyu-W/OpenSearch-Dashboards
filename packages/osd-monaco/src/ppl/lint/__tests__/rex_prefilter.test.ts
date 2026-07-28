/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as antlr from 'antlr4ng';
import {
  OpenSearchPPLLexer,
  OpenSearchPPLParser,
  SimplifiedOpenSearchPPLLexer,
  SimplifiedOpenSearchPPLParser,
} from '@osd/antlr-grammar';
import {
  buildExtractionPrefilterSpec,
  collectExtractionTargets,
  exactSubstringPattern,
  findRecognizedPrefilter,
  proveSafePrefilterInsertion,
  validateRexPrefilterRewrite,
} from '../rex_prefilter';
import {
  createCompiledRuleNameToIndex,
  createRuntimeRuleNameToIndex,
  RuleNameToIndex,
} from '../rule_index';
import { runLint } from '../lint_runner';

interface Parsed {
  tree: antlr.ParserRuleContext;
  ruleNameToIndex: RuleNameToIndex;
}

function compiled(query: string): Parsed {
  const lexer = new SimplifiedOpenSearchPPLLexer(antlr.CharStream.fromString(query));
  const parser = new SimplifiedOpenSearchPPLParser(new antlr.CommonTokenStream(lexer));
  parser.removeErrorListeners();
  return { tree: parser.root(), ruleNameToIndex: createCompiledRuleNameToIndex() };
}

function runtime(query: string): Parsed {
  const lexer = new OpenSearchPPLLexer(antlr.CharStream.fromString(query));
  const parser = new OpenSearchPPLParser(new antlr.CommonTokenStream(lexer));
  parser.removeErrorListeners();
  const indices = new Map(parser.ruleNames.map((name, index) => [name, index]));
  return {
    tree: parser.root(),
    ruleNameToIndex: createRuntimeRuleNameToIndex(indices),
  };
}

function specFor(parsed: Parsed, extractionIndex = 0) {
  const target = collectExtractionTargets(parsed.tree, parsed.ruleNameToIndex)[extractionIndex];
  const spec = target && buildExtractionPrefilterSpec(target, parsed.ruleNameToIndex);
  expect(spec).toBeDefined();
  return spec!;
}

describe('rex prefilter analysis', () => {
  it('derives the exact literal, token, and valid capture fields', () => {
    const parsed = compiled(
      'source=logs | rex field=body "logtype=(?<logtype>[^\\s]+) ' +
        'status=(?<httpstatus>\\d+) (?<bad_name>.*)"'
    );
    const spec = specFor(parsed);
    expect(spec.literalRun).toBe('logtype=');
    expect(spec.token).toBe('logtype');
    expect(spec.captureFields).toEqual(new Set(['logtype', 'httpstatus']));
    expect(exactSubstringPattern(spec)).toBe('%logtype=%');
  });

  it.each([
    ['percent', 'source=logs | rex field=body "log%type=(?<x>.*)"'],
    ['underscore', 'source=logs | rex field=body "log_type=(?<x>.*)"'],
    ['quote', `source=logs | rex field=body '"logtype=(?<x>.*)'`],
  ])('declines an automatic LIKE rewrite for a %s literal', (_name, query) => {
    const parsed = compiled(query);
    const target = collectExtractionTargets(parsed.tree, parsed.ruleNameToIndex)[0];
    const spec = target && buildExtractionPrefilterSpec(target, parsed.ruleNameToIndex);
    expect(spec === undefined || exactSubstringPattern(spec) === undefined).toBe(true);
  });
});

describe('recognized extraction prefilters', () => {
  const extraction = '| rex field=body "logtype=(?<logtype>[^\\s]+)"';

  function recognized(query: string) {
    const parsed = compiled(query);
    return findRecognizedPrefilter(parsed.tree, specFor(parsed), parsed.ruleNameToIndex);
  }

  it('recognizes exact match_phrase and LIKE predicates', () => {
    expect(
      recognized(`source=logs | where match_phrase(body, 'logtype') ${extraction}`)?.kind
    ).toBe('match-phrase');
    expect(recognized(`source=logs | where like(body, '%logtype=%') ${extraction}`)?.kind).toBe(
      'exact-substring'
    );
  });

  it('normalizes equivalent quoted and dotted field references', () => {
    const parsed = compiled(
      "source=logs | where LIKE(`event`.`body`, '%logtype=%') " +
        '| rex field=event.body "logtype=(?<logtype>.*)"'
    );
    expect(
      findRecognizedPrefilter(parsed.tree, specFor(parsed), parsed.ruleNameToIndex)
    ).toBeDefined();
  });

  it('recognizes a required conjunct and requires every OR branch', () => {
    expect(
      recognized("source=logs | where status = 200 AND match_phrase(body, 'logtype') " + extraction)
    ).toBeDefined();
    expect(
      recognized("source=logs | where match_phrase(body, 'logtype') OR status = 200 " + extraction)
    ).toBeUndefined();
    expect(
      recognized(
        "source=logs | where match_phrase(body, 'logtype') " +
          "OR LIKE(body, '%logtype=%') " +
          extraction
      )
    ).toBeDefined();
  });

  it('rejects negated, wrong-field, wrong-literal, and post-extraction filters', () => {
    expect(
      recognized(`source=logs | where NOT match_phrase(body, 'logtype') ${extraction}`)
    ).toBeUndefined();
    expect(
      recognized(`source=logs | where match_phrase(message, 'logtype') ${extraction}`)
    ).toBeUndefined();
    expect(
      recognized(`source=logs | where LIKE(body, '%message=%') ${extraction}`)
    ).toBeUndefined();
    expect(
      recognized(`source=logs ${extraction} | where LIKE(body, '%logtype=%')`)
    ).toBeUndefined();
  });

  it('does not treat wildcard-bearing literal runs as exact LIKE substrings', () => {
    const parsed = compiled(
      "source=logs | where LIKE(body, '%log%type=%') " +
        '| rex field=body "log%type=(?<logtype>.*)"'
    );
    const spec = specFor(parsed);
    expect(exactSubstringPattern(spec)).toBeUndefined();
    expect(findRecognizedPrefilter(parsed.tree, spec, parsed.ruleNameToIndex)).toBeUndefined();
  });

  it('ignores matching text inside another literal', () => {
    expect(
      recognized(`source=logs | where message = "match_phrase(body, 'logtype')" ${extraction}`)
    ).toBeUndefined();
  });

  it('does not cross append branches', () => {
    const parsed = compiled(
      "source=logs | append [ source=other | where LIKE(body, '%logtype=%') ] " + extraction
    );
    expect(
      findRecognizedPrefilter(parsed.tree, specFor(parsed), parsed.ruleNameToIndex)
    ).toBeUndefined();
  });

  it('does not carry a prefilter across rows introduced by append', () => {
    const parsed = compiled(
      "source=logs | where LIKE(body, '%logtype=%') " + '| append [ source=other ] ' + extraction
    );
    expect(
      findRecognizedPrefilter(parsed.tree, specFor(parsed), parsed.ruleNameToIndex)
    ).toBeUndefined();
  });

  it('does not cross a join-right subsearch', () => {
    const parsed = compiled(
      "source=logs | join [ source=other | where LIKE(body, '%logtype=%') ] " + extraction
    );
    expect(
      findRecognizedPrefilter(parsed.tree, specFor(parsed), parsed.ruleNameToIndex)
    ).toBeUndefined();
  });

  it('invalidates an upstream prefilter when eval replaces the source field', () => {
    expect(
      recognized("source=logs | where LIKE(body, '%logtype=%') | eval body = message " + extraction)
    ).toBeUndefined();
    expect(
      recognized(
        "source=logs | where LIKE(body, '%logtype=%') | eval service = message " + extraction
      )
    ).toBeDefined();
  });

  it('invalidates an upstream prefilter when an extraction overwrites the source field', () => {
    const parsed = compiled(
      "source=logs | where LIKE(body, '%logtype=%') " +
        '| rex field=message "(?<body>.*)" ' +
        extraction
    );
    expect(
      findRecognizedPrefilter(parsed.tree, specFor(parsed, 1), parsed.ruleNameToIndex)
    ).toBeUndefined();
  });

  it('treats a rex offset field as an extraction output', () => {
    const parsed = compiled(
      "source=logs | where LIKE(body, '%logtype=%') " +
        '| rex field=message offset_field=body "(?<value>.*)" ' +
        extraction
    );
    expect(
      findRecognizedPrefilter(parsed.tree, specFor(parsed, 1), parsed.ruleNameToIndex)
    ).toBeUndefined();
  });

  it('treats rex sed mode as a source-field rewrite', () => {
    const parsed = compiled(
      "source=logs | where LIKE(body, '%logtype=%') " +
        '| rex field=body mode=sed "s/logtype/message/" ' +
        extraction
    );
    expect(
      findRecognizedPrefilter(parsed.tree, specFor(parsed, 1), parsed.ruleNameToIndex)
    ).toBeUndefined();
  });

  it('invalidates an upstream prefilter across a field-producing stage', () => {
    expect(
      recognized(
        "source=logs | where LIKE(body, '%logtype=%') " +
          '| stats values(message) as body ' +
          extraction
      )
    ).toBeUndefined();
  });

  it('covers only the extraction whose required literal matches', () => {
    const parsed = compiled(
      "source=logs | where match_phrase(body, 'logtype') " +
        '| rex field=body "logtype=(?<logtype>.*)" ' +
        '| rex field=body "message=(?<message>.*)"'
    );
    const first = specFor(parsed, 0);
    const second = specFor(parsed, 1);
    expect(findRecognizedPrefilter(parsed.tree, first, parsed.ruleNameToIndex)).toBeDefined();
    expect(findRecognizedPrefilter(parsed.tree, second, parsed.ruleNameToIndex)).toBeUndefined();
  });

  it('uses the same AST recognition on the runtime grammar surface', () => {
    const parsed = runtime(
      "source=logs | where LIKE(body, '%logtype=%') " +
        "| parse body 'logtype=(?<logtype>[^\\\\s]+)'"
    );
    expect(findRecognizedPrefilter(parsed.tree, specFor(parsed), parsed.ruleNameToIndex)).toEqual(
      expect.objectContaining({ kind: 'exact-substring' })
    );
  });

  it('suppresses the runtime-surface detector only after a matching prefilter', () => {
    const ids = (query: string) => {
      const parsed = runtime(query);
      return runLint(parsed.tree, {
        ruleNameToIndex: parsed.ruleNameToIndex,
        context: {
          fields: new Set(['body']),
          typeMap: new Map([['body', 'text']]),
          overrides: { 'rex-scan-cost': { enabled: true } },
          grammarSurface: 'runtime-bundle',
        },
      })
        .filter((diagnostic) => diagnostic.ruleId === 'rex-scan-cost')
        .map((diagnostic) => diagnostic.ruleId);
    };
    const extractionQuery = "| parse body 'logtype=(?<logtype>[^\\\\s]+)'";
    expect(ids(`source=logs ${extractionQuery}`)).toEqual(['rex-scan-cost']);
    expect(ids(`source=logs | where LIKE(body, '%logtype=%') ${extractionQuery}`)).toEqual([]);
  });
});

describe('null-rejecting consumer proof', () => {
  function proof(predicate: string, between = '') {
    const parsed = compiled(
      'source=logs | rex field=body "logtype=(?<logtype>[^\\s]+) ' +
        'http_status=(?<httpstatus>\\d+) uri=(?<uri>[^\\s]+)" ' +
        `${between}| where ${predicate}`
    );
    return proveSafePrefilterInsertion(parsed.tree, specFor(parsed), parsed.ruleNameToIndex);
  }

  it.each([
    ["logtype = 'ws:access'", 'logtype'],
    ["LIKE(httpstatus, '5%')", 'httpstatus'],
    ['ISNOTNULL(uri)', 'uri'],
    ["logtype = 'x' AND service = 'y'", 'logtype'],
    ["logtype = 'x' OR uri = 'y'", 'logtype'],
  ])('proves %s', (predicate, captureField) => {
    expect(proof(predicate)).toEqual(
      expect.objectContaining({ captureField, pattern: '%logtype=%' })
    );
  });

  it.each([["logtype = 'x' OR service = 'y'"], ["NOT logtype = 'x'"], ["service = 'y'"]])(
    'conservatively rejects %s',
    (predicate) => {
      expect(proof(predicate)).toBeUndefined();
    }
  );

  it('requires the null-rejecting WHERE to be the immediate next stage', () => {
    expect(proof("logtype = 'x'", '| eval service = 1 ')).toBeUndefined();
    expect(proof("logtype = 'x'", '| stats count() ')).toBeUndefined();
  });
});

describe('rex-scan-cost candidate rewrite policy', () => {
  const original =
    'source=logs | rex field=body "logtype=(?<logtype>[^\\s]+)" ' + "| where logtype = 'ws:access'";

  function verdict(candidate: string) {
    const before = compiled(original);
    const after = compiled(candidate);
    return validateRexPrefilterRewrite(before.tree, after.tree, before.ruleNameToIndex);
  }

  it('accepts exactly one required substring filter immediately before rex', () => {
    expect(
      verdict(
        "source=logs | WHERE LIKE(body, '%logtype=%') " +
          '| rex field=body "logtype=(?<logtype>[^\\s]+)" ' +
          "| where logtype = 'ws:access'"
      )
    ).toEqual({ accepted: true });
  });

  it('rejects match_phrase as analyzer-dependent', () => {
    expect(
      verdict(
        "source=logs | where match_phrase(body, 'logtype') " +
          '| rex field=body "logtype=(?<logtype>[^\\s]+)" ' +
          "| where logtype = 'ws:access'"
      )
    ).toEqual({ accepted: false, reason: 'unsafe-prefilter' });
  });

  it('returns precise field and literal mismatch reasons', () => {
    expect(
      verdict(
        "source=logs | where LIKE(message, '%logtype=%') " +
          '| rex field=body "logtype=(?<logtype>[^\\s]+)" ' +
          "| where logtype = 'ws:access'"
      ).reason
    ).toBe('nonmatching-prefilter-field');
    expect(
      verdict(
        "source=logs | where LIKE(body, '%logtype%') " +
          '| rex field=body "logtype=(?<logtype>[^\\s]+)" ' +
          "| where logtype = 'ws:access'"
      ).reason
    ).toBe('prefilter-not-exact-substring');
  });

  it('rejects misplaced filters and any additional command change', () => {
    expect(
      verdict(
        'source=logs | rex field=body "logtype=(?<logtype>[^\\s]+)" ' +
          "| where LIKE(body, '%logtype=%') | where logtype = 'ws:access'"
      ).reason
    ).toBe('prefilter-not-before-extraction');
    expect(
      verdict(
        "source=logs | where LIKE(body, '%logtype=%') " +
          '| rex field=body "message=(?<logtype>[^\\s]+)" ' +
          "| where logtype = 'ws:access'"
      ).reason
    ).toBe('multiple-command-changes');
  });
});
