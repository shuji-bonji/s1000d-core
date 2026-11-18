# Changelog

## 未リリース（0.15.0 の見込み）

発行済みのデータモジュールを S1000D の版の決まりに沿って直すための操作を 3 つ足しました（設計は s1000d-stack の `docs/design/core-revision.md`、決定は DECISIONS の D-33）。

### 追加

- **作業中の版を始めます（`startRevision`）。** 発行済みの版（`inWork` が `00`）の XML から、`inWork` が `01` の XML を作ります。`issueNumber` はそのままで、`issueType` は入力の値（`changed`・`revised`・`status`。`001-00` から始めるときだけ `new` も選べます）にします。値は補いません。前の版の変更の印（3 つの属性、`changeInline` のタグ、`reasonForUpdate`）を消し、`changeType="delete"` の要素を取り除きます。取り除く要素の `id` を残る部分が指していれば、`id-referenced` で断ります。元の文字列の、書き換える範囲だけを書き換えます。`issueDate`・`qualityAssurance`・本文は変えません。DM では、作業中の版のファイル名（`fileName`）も返します。発行（`inWork` を `00` に戻し、`issueNumber` を上げる）は扱いません。
- **`editContent` に、変更の印を付ける指定（`options.marking`）を足しました。** 渡さなければ、これまでと同じ動きです。渡したときは次のとおりです。
  - insert は、足した要素に `changeType="add"` を付けます。
  - remove は、要素を取り除かずに `changeType="delete"` を付けて残します（`changes[].kept` が `true`）。この作業中の版で足した要素（`changeType="add"`）は、印を付けずに取り除きます。
  - move は、同じ親の中だけを受け付け、親に `changeType="modify"` を付けます。親が変わる移動は `move-across-parents`、印の属性を持てない親（`description`・`procedure` など）の中の移動は `parent-not-markable` で断ります。
  - `add`・`delete` の印を持つ要素の中への編集には、印を付けません。
  - 印を 1 つでも付けたときは、`dmStatus` の中の XSD が決める位置（`productSafety`・`remarks` の前）に `reasonForUpdate` を 1 つ足し、付けた印はすべてそれを指します。`id` を省略すると、文書に無い値（`rfu-0001` の形）を作ります。結果の `reasonForUpdate`（`added` が `true`）と `changes[].mark` に、足した理由と付けた印を返します。
  - 同じ理由による 2 回目からの編集では、`marking.reason` の代わりに `marking.reasonRefId` に、識別・状態部に既にある `reasonForUpdate` の `id` を渡します。印はその `reasonForUpdate` を指し、識別・状態部は変えません（結果の `reasonForUpdate.added` は `false`）。同じ理由の変更が同じ `reasonForUpdate` を指す、という決まり（Chap 3.9.5.2.1.1 Para 2.1.3）に沿うための入口です。`reason` と `reasonRefId` は、どちらか一方だけを渡します。`id` が識別・状態部の `reasonForUpdate` に無ければ `marking-input-error`、その `reasonForUpdate` が `urt01` なら `editorial-reason` で断ります。
  - 発行済みの版は、`allowReleasedIssue` があっても断ります。`issueType` が `changed`・`status`・`rinstate-changed`・`rinstate-status` でない版は `issue-type-not-markable`、`updateReasonType` が `urt01`（編集上の変更）のときは `editorial-reason` で断ります。`updateReasonType` と `changeMark` は必須です。
  - 印を付けて残す要素の前後には、同じ呼び出しで節点を足せます（置き換えは、remove と、その隣への insert で書きます）。
- **識別・状態部に、更新の理由だけを足します（`addReasonForUpdate`）。** `dmStatus` の中の XSD が決める位置（`productSafety`・`remarks` の前）に `reasonForUpdate` を 1 つ足します。本文には触らず、変更の印も付けません。変更の印を付けない変更の理由を書くための入口です。編集上の変更（`urt01`。この理由に結び付く変更の印があってはなりません）と、`issueType` が `revised`・`status` の版（変更の印を持てませんが、既定 BREX の BREX-S1-00038 は `reasonForUpdate` を求めます）で使います。`text` と `updateReasonType` は必須で、`id` を省略すると文書に無い値を作ります。発行済みの版は `released-issue` で断ります。ここで足した理由を、後の編集の印から指すときは、`editContent` の `marking.reasonRefId` に `id` を渡します。
- **開始タグの中の属性の範囲を求める関数を足しました**（`scanAttributes`・`setAttributeSplice`・`removeAttributeSplice`・`attributeInsertPosition`・`escapeAttributeValue`）。属性 1 つを書き換える・足す・取り除く操作を、元の文字列の範囲として返します。

### 扱っていないもの

- 文の一部の変更（`changeInline` を付ける編集）、表・図への変更の印、DM の削除と復帰は扱いません。
- `issueType` を `revised`・`status` にして作業中の版を始めると、前の版の `reasonForUpdate` が無くなるので、既定 BREX の BREX-S1-00038 が求める `reasonForUpdate` が 1 つも無い状態になります（`notes` で知らせます）。`startRevision` は理由を受け取らないので、続けて `addReasonForUpdate` を呼びます。

### テスト

- 自作の DM のテストを 16 件足しました（`src/revision/revision.test.ts`）。
- 配布物を使うテストを 3 件足しました（`src/revision/revision.spec.test.ts`）。Bike Samples の DMC 106 件のうち、`issueType` が `deleted` の 3 件を除く 103 件で作業中の版を始め、取り除いた `reasonForUpdate` は 120 個、印の属性を取り除いた要素は 14 個でした。103 件とも、XSD のエラーと、版と印に関わる既定 BREX のルール（BREX-S1-00030・00032・00033・00036・00038）の違反は増えませんでした（`issueType` は `changed`）。手順 DM では、印を付けて手順を足す・取り除く編集の後も同じでした。

## 0.14.0 (2026-11-17)

更新の理由（`reasonForUpdate`）と変更の印（`changeType`・`changeMark`・`reasonForUpdateRefIds`）を読むようにしました。これまでは、どちらも読み取りの結果に無く、無いことの知らせもありませんでした（s1000d-stack の DECISIONS D-31「読む側は落とさない」、D-33 の「先に要る作業」）。あわせて、手順の `text` にまとめた段落の場所を返します（D-32）。次の版は 0.14.0 です（読み取りの結果に項目が増えます。これまでの項目は変わりません）。

### 追加（読み取りの結果に項目が増えます）

- **識別・状態部の更新の理由を読みます。** `IdentAndStatus.reasonForUpdates` は、`dmStatus/reasonForUpdate` を並びの順に返します。1 件は、`id`・`updateReasonType`・`updateHighlight`・`applicRefId`（書かれた値のまま）、そのほかの属性（`attrs`。`controlAuthorityRefs` など）、子の `simplePara`・`simpleRefPara` の文（`paragraphs`）です。段落の中の DM への参照は `[→ DMC]` の形で文に埋め込みます。`reasonForUpdate` が 1 つも無ければ、項目そのものがありません。`updateReasonType` の値（`urt01` など）の意味は付けません。
- **節点と参照に、要素自身の変更の印を返します。** `ContentNode.change` と `ContentRef.change` は、`changeType`・`changeMark`（書かれた値のまま）と `reasonForUpdateRefIds`（空白で分けた配列）です。3 つの属性がどれも書かれていない要素には付きません。品目・故障の報告などの節点の `attrs` には、この 3 つの属性を入れなくなりました（`change` に入ります）。
- **変更の印を持つ要素の一覧（`DataModuleContent.changeMarks`）を返します。** 3 つの属性のどれかを持つ要素と `changeInline` を、文書の順にすべて返します。1 件は、要素名（`element`）、場所（`path`・`line`・`column`）、3 つの属性です。節点にならない要素（`title`、表の `row`、手順の `text` にまとめた `para`、行内の `changeInline`、識別・状態部の要素）と、本文を構造化して読まない種類の DM（`structured` が false。`wrngdata` など）の要素も入ります。1 つも無ければ空の配列です。`changeInline` の中の文は、これまでどおり節点の `text` に入ります。
- **手順の節点に、`text` にまとめた段落ごとの場所（`textLocations`）を返します。** 手順（`kind: "step"`）は、直下の子を持たない段落をすべて `text` にまとめるので、その段落には節点も `location` もありませんでした。`textLocations` は、まとめた段落ごとの `NodeLocation` を並びの順に持ちます。`editContent` の `remove`・`move` の場所（`at`）に使えます。まとめた段落が無い手順には付きません。リストの項目（`listItem`）は、段落が 1 つのときにその段落を `text` にまとめますが、`textLocations` は付けません（項目そのものを対象にします）。

### 読んでいないもの

- パブリケーションモジュールの `pmStatus/reasonForUpdate` は読んでいません（`IdentAndStatus` はデータモジュールの識別・状態部だけを読みます）。PM の中の変更の印は、`readContent` の `changeMarks` に入ります。

### テスト

- 自作の DM のテストを 5 件足しました（印を節点・参照・節点にならない要素に書いた手順 DM、本文を構造化して読まない種類の DM、更新の理由 3 件）。
- 配布物を使うテストを 3 件足しました（`src/content/change.spec.test.ts`）。Bike Samples の DMC 106 件で、元の文字列を正規表現で数えた数と比べます。`reasonForUpdate` は 97 件に 124 個、変更の印の属性を持つ要素は 3 件に 14 個（`wire` 10・`electricalEquip` 2・`graphic` 2。12 個は本文を構造化して読まない `wrngdata` の DM）、まとめた段落が 2 つ以上の手順は 7 件に 11 個で、その 11 個すべてで、`textLocations` の場所の `para` を取り除く編集と移す編集が適用されます。

## 0.13.0 (2026-11-17)

### 追加

- **既にあるデータモジュールの構造を変える編集（`editContent`）を足しました。** 節点を足す（`insert`）・取り除く（`remove`）・移す（`move`）の 3 つの操作です。設計は s1000d-stack の docs/design/core-structural-edit.md にあります。
  - 場所は、編集の前の文書の `location.path`（`readContent` が返すもの）で指します。複数の編集を渡すときも、すべて編集の前の場所で書きます。
  - 1 つでも断る理由があれば、1 つも適用しません。断った編集ごとに、理由（`refusals[].reason`）と場所を返します。
  - **元の文字列の、編集した範囲だけを書き換えます。** 触っていない部分は 1 文字も変わりません。移した要素の中身も変わりません。`applyFix`・`applySegments` は文書要素の全体を直列化し直すので、開始タグの属性の改行などが変わります（Bike Samples の DMC・PMC 110 件では、何も変えなくても 91,215 行のうち 26,258 行が変わります）。`editContent` はこの方法を使いません。
  - 文字列を書き換えた結果を読み直し、DOM で同じ操作をした結果と比べます。合わなければ `internal-mismatch` で断ります。
  - 対象の要素は `proceduralStep`・`para`・`warning`・`caution`・`note`・`listItem` です（`EDITABLE_ELEMENTS`）。足す節点は `DraftNode`（`step`・`para`・`admonition`・`listItem`）で渡し、手順 DM と説明 DM に足せます。
  - 取り除く節点（子孫を含む）の `id` を、残る部分の属性（`internalRefId`・`applicRefId`・`warningRefs` など）が指しているときは `id-referenced` で断り、指している要素の場所を返します。足す節点の `id` が文書に既にあるときは `id-duplicate` です。
  - **版（`issueInfo`）も変更の印（`changeType`・`changeMark`・`reasonForUpdate`）も変えません。** 発行済みの版（`issueInfo/@inWork` が `00`）は `released-issue` で断ります。`allowReleasedIssue: true` を渡すと適用し、`notes` にそのことを書きます。
  - 親がその位置にその要素を取れるか（XSD の内容モデルの順序）は確かめません。`options.xsd`（`XsdIndex`）を渡すと、親がその名前の子を取れるかだけを確かめます（`not-allowed-here`）。順序の誤りは、適用の後の XSD の検証で見つかります。
- **要素が元の文字列の中で占める範囲を求める関数（`scanElementRanges`・`rangeOfElement`・`rangesMatchDocument`）を足しました。** コメント・CDATA・処理命令と、属性の値の中の `>` を読み飛ばします。DOM の要素との対応は、文書要素から数えた子要素の番号で取ります。

### テスト

- `editContent` と要素の範囲のテストを 17 件足しました。配布物を使うテストを 4 件足しました（手順 DM 39 件のすべてで、最初の手順の後ろに手順を足せて、足した 3 行のほかは元の文字列と同じであること、Bike Samples の 110 件すべてで範囲が DOM と対応すること、対象の要素を取り除く編集が文字列と DOM で同じ結果になること、手順が 2 つ以上ある手順 DM 39 件で、最後の手順を 1 つ前の要素の前に移して戻すと行の集まりが元と同じになること。39 件のうち 37 件は元の文字列と同じになり、残りの 2 件は 2 つの要素の間にコメントがあって、コメントの位置だけが入れ替わります）。

## 0.12.0 (2026-11-17)

Bike Samples の本文で、あることを知らせるだけだった残りの要素を読むようにしました。本文を構造化して読む 59 件のテキスト節点 1,587 個のうち、読み取りの結果に無いものは 13 個から 0 個になりました（s1000d-stack の DECISIONS D-31「読む側は落とさない」、docs/notes/tm-eval-progress.md）。あわせて、条件付きで禁止する BREX ルールの修正候補を直しました。次の版は 0.12.0 です（読み取りの結果と、修正候補が変わります）。

### 変更（読み取りの結果が変わります）

- **品目の危険性（`hazards`）を読みます。** 品目（`equipment`・`supply`・`spare`）の節点の `children` に、入れ子の品目の後ろに入ります。`hazard` は `kind: "list"`・`element: "hazard"` の節点で、`refs` が記号の図（`symbol`）、`attrs.hazardousClass` が区分の値（`hazardousClassValue`）を空白で区切ったもの、子の `listItem`（`element: "safetyInformation"`）が安全の情報の文です。`hazardRef` は `kind: "para"`・`element: "hazardRef"` の節点で、`attrs.hazardIdentNumber` と参照を持ちます。値は解釈しません。
- **品目のほかの識別子を読みます。** `toolRef`・`supplyRef`・`supplyRqmtRef`・`materialSetRef`・`catalogSeqNumberRef`・`partRef`・`functionalItemRef` と、2 つ目からの `natoStockNumber` を、節点の `identifiers`（`ContentIdentifier` の配列）に返します。1 件は、要素名（`element`）、書かれている属性すべて（`attrs`）、`name`・`shortName` の文、参照（`refs`）です。これまでどおり `attrs.otherIdentifiers` に要素名の並びも入ります。これらを `notReadElements` に数えなくなりました。
- **品目の備考の脚注を読みます。** `footnoteRemarks` の文は `remarks` と同じく節点の `text` に入り、`attrs.remarksElement` が `"footnoteRemarks"` になります。`footnoteRef` は `refs` に `kind: "internalRef"`・`note: "footnoteRef"` で入ります。グループの直下の `footnote` は、その種類の品目の後ろに `kind: "para"`・`element: "footnote"` の節点として返します（`attrs.footnoteMark`）。
- **作業の場所・所要時間・間隔（`productionMaintData`）を読みます。** `requirements` の子の、`kind: "para"`・`element: "productionMaintData"` の節点です。`attrs` に `taskDuration` の属性（`taskDuration.unitOfMeasure`・`taskDuration.procedureDuration` など）、子に `thresholdInterval`（`text` が値）と `workAreaLocationGroup` が入ります。`workAreaLocationGroup` の子は `zoneRef`・`accessPointRef`（`title` が `name`、`attrs` が属性）と `workLocation`（`text` が文、子が `workArea`・`productItem` など）です。これまでは `kind: "unknown"`・`attrs.notRead` の節点 1 つでした。
- **プロセス DM の変数の宣言・代入・検査を読みます。** `variableDeclarations` は `kind: "list"` の節点で、子の `listItem`（`element: "variable"`）の `attrs` に属性と、初期値があれば `initialValue` が入ります。`variablePreSet`・`variablePostSet`・`assertion` は `kind: "para"` の節点で、`attrs.variableName` と `attrs.expression` を持ちます。メニューの選択肢（`menuChoice`）の `assertion` は、その `listItem` の子です。`validate` は `attrs.errorMessage` と `attrs.expression` を持ちます。式は評価せず、書かれた値と演算の名前を並べた文にします（例: `(age greaterThanOrEqual 4) and (age lessThanOrEqual 100)`、`names add name`、`"amateur"`）。この書き方で表せない式は、`notReadElements` に `expression` と数えます。代入先が `globalPropertyRef` のときは `globalPropertyRef` と数えます。
- **図の改訂の理由（`graphic/reasonForAmendment`）を読みます。** 図への参照（`ContentRef`）の `reasonForAmendment` に文が入ります。
- **`dmIf` の条件の式を `attrs.expression` に読みます。** 式は評価せず、変数の宣言・代入・検査と同じ書き方の文にします（例: `not(level equal "experienced")`）。`question` は、これまでどおり人が書いた文（`expression/@humanReadableForm`）だけです。`humanReadableForm` がある式や、変数 1 つだけの式（`attrs.variableName`）でも、`attrs.expression` が入ります。これまでは、`humanReadableForm` が無く変数 1 つでもない式は、`kind: "unknown"` の子として返していました。文にできない式は、これまでどおり `unknown` の子です。
- **繰り返し（`dmLoop`）を節点として返します。** `kind: "sequence"`・`element: "dmLoop"` の節点で、条件の式が `attrs.expression`（`humanReadableForm` があれば `attrs.humanReadableForm`）、子が前の代入（`variablePreSet`）・繰り返す `dmSeq`・後ろの代入（`assertion`）です。これまでは節点を作らずに子だけを返していたので、条件の式が外側の節点の `unknown` の子になっていました。プロセス DM の読み取りの結果は、`dmLoop` のところで階層が 1 段増えます。
- **式の中の適用性の条件（`assert`）を文にします。** `assert(識別子 種類 "値")` の形です（例: `assert(tourFinished condition "False")`）。属性が無く文だけの `assert` は `assert("文")` です。これまでは、`assert` を含む式を `notReadElements` に `expression` と数えていました。式の中の `globalPropertyRef` は、まだ文にできません。
- **故障の報告（`faultReporting`）を、節点として読みます。** これまでは、ほとんどの要素を `kind: "unknown"` の節点で返していました。新しい `kind` は足さず、`element` で元の要素を区別します（形は Issue 7 の `fault.xsd` と Bike Samples の 4 件から決めました）。
  - 不具合 1 件（`isolatedFault`・`detectedFault`・`observedFault`・`correlatedFault`）は `kind: "section"` の節点で、`id` と `attrs.faultCode`・`attrs.faultType` を持ちます。**これまで `detectedFault`・`isolatedFault`・`correlatedFault` は節点を作らずに子だけを返していたので、`id` と `faultCode` が読み取りの結果にありませんでした。** fault の読み取りの結果は、ここで階層が 1 段増えます。`…Alts` の容れ物は、中身をそのまま辿ります。
  - `detectionInfo`・`contextAndIsolationInfo`・`isolationInfo`・`basicCorrelatedFaults`・`diagnosticProcess` と、`lruItem`・`detectedLruItem`・`locateAndRepairLruItem`・`sruItem`・`detectedSruItem`・`locateAndRepairSruItem` は `section` で、書かれている属性（`detectionType`・`faultProbability` など）が `attrs` に入ります。
  - `lru`・`sru` は `kind: "para"` の節点で、`title` が名前です。識別子は品目（`equipment` など）と同じ項目に入ります（`partNumber`・`manufacturerCode`・`natoStockNumber`・`identifiers`、`attrs.shortName`）。2 つ目からの `identNumber`・`partAndSerialNumber` と `serialNumber` は読まず、`notReadElements` に数えます。
  - `bitMessage`・`warningMalfunction`・`assocWarningMalfunction` は `section` で、`attrs.faultCode` が `fault/@faultCode`、`refs` が `dmRef` です。中の `faultDescr` の `attrs.faultCode` はこれまでどおりです。
  - `faultIsolationTest` は `section` で、`title` が `testDescr/testName`、`attrs` が `testType`・`testCode`、子が `testParameters`（`para`。`attrs` が `from`・`to`・`unitOfMeasure`）と `testProcedure` です。
  - `faultContext`・`diagnosticsReason` は `para`（`text` が文）、`repair`・`testProcedure`・`faultIsolationRef` は `para`（`refs` が参照、`text` に `[→ …]`）です。`remarks` は `para` で、文が 1 つなら `text`、複数なら子の `para` です。
  - `faultDescr` の `detailedFaultDescr` の子（`systemName`・`faultMessageBody` など）は、`faultDescr` の子の `para`（`element` が元の要素名）です。
- **回路遮断器の一覧（`circuitBreakerDescrGroup`）を読みます。** グループとサブグループは `kind: "list"`（`attrs` に `circuitBreakerAction` など）、遮断器 1 つ（`circuitBreakerDescr`）は `listItem` で、`title` が名前、`text` が場所（`circuitBreakerLocation`）、`attrs` が `circuitBreakerRef` の属性、`identifiers` が `circuitBreakerRef` と `accessPointRef` です。手順の中のものは手順の子、条件（`reqCondCircuitBreaker`）の中のものはその条件の `para` の子です。条件の `attrs.notRead` と、`notReadElements` の `circuitBreakerDescrGroup` は無くなりました。
- **`userEntry` の入力先の変数（`variableRef`）を、`unknown` に数えなくなりました。** 変数名はこれまでどおり `dialog` の節点の `attrs.variableName` に入ります。これまでは同じ `variableRef` が、子の `kind: "unknown"` の節点と `unknownElements` にも現れていました。

### 修正

- **条件付きで禁止する BREX ルールの修正候補を、条件を成り立たなくする変更にしました。** objectPath に述語がある禁止ルール（既定 BREX の禁止ルール 160 件のうち 158 件）に対して、`suggestFixes` は「この要素を取り除く」を `exact` で返していました。BREX-S1-00030 では `identAndStatusSection` を、BREX-S1-00038 では文書要素を取り除く候補になり、選べませんでした。`exact` の候補は writer が自動で適用するので、危険でもありました。
  - objectPath に書いてある属性の比較（`@a = "v"`・`@a != "v"`）と、要素が無いこと（`not(child::e)`）を拾い、文書を 1 か所だけ変えて objectPath を評価し直します。その要素が選ばれなくなる変更だけを候補にします。属性の値は、XSD が列挙していればその中から試します。
  - 候補の `target` は、違反の場所から見た道です（例: `identAndStatusSection/dmStatus/@issueType`、足す要素の親 `identAndStatusSection/dmStatus`）。`applyFix` がこの形の `replace` と `add` を適用します。足した要素は空です（中身は人が書きます）。
  - 対象そのものの識別（`dmAddress` などの下のコード・`issueNumber`・`inWork`）を変える候補は出しません。
  - 条件付きのルールでは、確からしさは `several` か `none` です。候補を決められなければ候補なし（`none`）で、取り除く候補は出しません。述語の無い objectPath は、これまでどおり「取り除く」を `exact` で返します。
  - この候補を作るために、`suggestFixes` は `options.xml` と XSD の定義を BREX の候補にも使います。`suggestBrexFixes` の選択項目に `document`・`engine`・`xsd` を足しました。
- **属性が無いこと（`not(@a)`・`not(attribute::a)`）が条件の BREX ルールに、候補と注記を返します。** これまでは、足す値を決められないので候補なしでした。
  - その属性が無い要素に属性を足して objectPath を評価し直します。1 か所に足すだけで違反が消え、足す値の出どころがあるときだけ、`add` の候補を返します（`target` は `道/@属性名`。違反の要素そのものなら `@属性名`）。値の出どころは、XSD が列挙している値と、`applicRefId` のときの文書の中の `applic` の `id` です。確からしさは `several` です（どの値を付けるかは内容の判断なので、`exact` にしません）。
  - 属性が無い場所が複数あって 1 か所では違反が消えないとき、値の出どころが無いときは、候補なし（`none`）のままです。`note` に、属性が無い場所の数と最初の 3 つの道、使える値を書きます。Bike Samples の BREX-S1-00121（目次の `dmRef` 82 個すべてに `applicRefId` が無い）は、この形になります。
  - `applyFix` は、`target` が `道/@属性名` の `add` を適用します。
- **`applyFix`・`applyFixes` が `candidate-not-offered` で断るときに、食い違った項目を `notes` に書きます。** 場所が同じ提案の候補のうち、`action` と値は合うのに `target`・`position` だけが違うものがあれば、その候補の `target` を知らせます（例: `The selection has target (none), but the candidate offered at … with the same action and value has target "identAndStatusSection/dmStatus/@issueType".`）。その場所に提案が無いとき、その `action` の候補が無いとき、値が合う候補が無いときも、それぞれ文にします。照合の厳しさは変わりません（`target` を省いた選択は、これまでどおり適用しません）。

### テスト

- 読み取りのテストを 3 件足し、4 件を書き直しました。条件付きのルールの候補のテストを 7 件足しました（299 件。配布物を使う 39 件はスキップ）。
- 配布物を使うテスト（`src/content/coverage.spec.test.ts`）の上限を、読み取りの結果に無いテキスト節点 13 個 → 0 個、1 つも落とさずに読めた DM 55 件 → 59 件に変えました。`preliminaryRqmts` の往復の数（失われる要素・属性 602 個、26 件）は変わりません。
- 配布物を使うテスト（`src/spec.test.ts`）の実測値を更新しました（プロセス DM の `sequence` 4 → 5）。Bike Samples の本文を構造化して読む DM のどれにも、知らない要素（`kind: "unknown"`）が無いことを確かめます。

## 0.11.0 (2026-11-16)

Bike Samples の本文のうち、読み取りの結果に入っていなかった文を読むようにしました（s1000d-stack の DECISIONS D-31「読む側は落とさない」、docs/notes/tm-eval-progress.md）。読み取りの結果に無いテキスト節点は 66 個から 13 個になり、残りの 13 個はどれも `notReadElements` で知らせている要素の中にあります。次の版は 0.11.0 です（読み取りの結果が変わります）。

### 変更（読み取りの結果が変わります）

- **不具合の説明（`faultDescr`）を読みます。** `kind: "para"`・`element: "faultDescr"` の節点で、`text` が `descr` の文です。同じ親に `fault` があれば、`attrs.faultCode` にその `faultCode` を入れます（値は解釈しません）。これまでは何も返していませんでした。
- **メニューの選択肢（`menuChoice`）の文を読みます。** `listItem` の節点の `text` に、`prompt` の文が入ります。これまでは空の `listItem` でした。
- **利用者への知らせ（`message`）を読みます。** 中の `prompt` を 1 つずつ、`kind: "para"`・`element: "prompt"` の節点として返します。
- **図の凡例（`figure/legend`）を読みます。** `figure` の節点の `children` に、凡例の定義リストなどが入ります。
- **定義リストの見出し（`definitionListHeader`）を読みます。** `list` の節点の `attrs.termTitle`・`attrs.definitionTitle` に入ります。
- **折り込み（`foldout`）を容れ物として辿ります。** 中の `figure`・`table` が、題名と `id` を持つ節点として返ります。これまでは `element: "foldout"` の `figure` 1 つになり、中の図の題名が落ちていました。
- **外部の文書の版と発行日を読みます。** `externalPubRef` の参照（`ContentRef`）に `externalPubIssue`（`externalPubIssueInfo/externalPubIssue` の文）と `externalPubIssueDate`（`externalPubRefAddressItems/externalPubIssueDate` の文）を足しました。読めたときは、`notReadElements` に `externalPubIssueInfo`・`externalPubRefAddressItems` を入れません。
- **入れ子の品目（`embeddedSupportEquipDescr`・`embeddedSupplyDescr`・`embeddedSpareDescr`）を読みます。** 親の品目の `children` に、同じ種類（`equipment`・`supply`・`spare`）の節点として入ります。これまでは `attrs.notRead` と `notReadElements` で知らせるだけでした。下書き（`DraftNode`）の品目は子を受け取らないので、書く側は変わりません。

### 追加

- プロセス DM の変数の宣言・代入・検査（`variableDeclarations`・`variablePreSet`・`variablePostSet`・`validate`・`assertion`）と、図の改訂の理由（`graphic/reasonForAmendment`）を、`notReadElements` に数えるようにしました。中身はこれまでどおり読みませんが、あることを知らせます。

### テスト

- 上の 8 つを確かめるテストを 4 件足しました（289 件。配布物を使う 39 件はスキップ）。
- 配布物を使うテスト（`src/content/coverage.spec.test.ts`）の上限を、読み取りの結果に無いテキスト節点 66 個 → 13 個、1 つも落とさずに読めた DM 39 件 → 55 件に変えました。そのうち reader が知らせていないもの（`lostSilent`）が 0 個であることも確かめます。本文の先頭の適用性の文（`referencedApplicGroup`）は `readApplicStatements` が読むので、その結果も含めて数えます。

## 0.10.0 (2026-11-15)

実在の技術マニュアルの消耗品の一覧が、品目を部品番号ではなく NATO 物品番号（NSN）で示していたので、品目の識別子として `natoStockNumber` を読み書きできるようにしました（s1000d-stack の docs/notes/tm-eval-progress.md）。次の版は 0.10.0 です（下書きと読み取りの節点に項目を足し、読み取りの結果が変わります）。

### 追加

- 下書き（`DraftNode`）の `equipment`・`supply`・`spare` に `natoStockNumber`（任意）を足しました（JSON Schema も同じ）。数字 13 桁で、`6850-00-181-7933` のように 4-2-3-4 桁をハイフンで区切って書けます。
  - `natoStockNumber` 要素の 3 つの属性（`@natoSupplyClass` 4 桁、`@natoCodificationBureau` 2 桁、`@natoItemIdentNumberCore` 7 桁）に分けて書きます。属性の型は `xs:int` ですが、仕様書の例（`natoCodificationBureau="00"`）と同じく、0 で始まる桁をそのまま書きます。`fullNatoStockNumber` は書きません。
  - 13 桁の数字でなければ `DraftInputError`（`…/natoStockNumber`）です。
  - `manufacturerCode` もあるときは、`natoStockNumber`、`identNumber` の順に両方を書きます。
- 読み取りの節点（`ContentNode`）の `equipment`・`supply`・`spare` に `natoStockNumber` を足しました。3 つの属性があれば、書かれた値を `6850-00-181-7933` の形につなぎます（7 桁の番号は 3-4 桁に分けます。7 桁でなければそのまま）。属性が無ければ `fullNatoStockNumber`、それも無ければ要素の文を返します。属性と `fullNatoStockNumber` の両方があるときは、後者を `attrs.fullNatoStockNumber` に返します。
- `requirements` の要約の文（`text`）の品目に、`NSN 6850-00-181-7933` を入れます。

### 変更

- 品目に要る識別子が、「`manufacturerCode`」から「`natoStockNumber` か `manufacturerCode` のどちらか 1 つ以上」になりました。どちらも無い品目は、これまでどおり `DraftInputError`（`…/manufacturerCode`）です。`partNumber` を書くときは、`natoStockNumber` があっても `manufacturerCode` が要ります（`identNumber` に必須のため）。
- `natoStockNumber` を持つ品目を読んだとき、`attrs.otherIdentifiers` と `notReadElements` に `natoStockNumber` を入れなくなりました（中身を読むようになったため）。同じ品目の 2 つ目からの `natoStockNumber` と、`natoStockNumber` の子の `refs` は読んでいないので、`notReadElements` に数えます。

### テスト

- 書いた `natoStockNumber` を読み直して同じ番号が返ること、読み取りの 6 つの形（属性、属性と文字列、文字列だけ、要素の文、欠けた番号、2 つと参照）を確かめるテストを足しました（285 件。配布物を使う 39 件はスキップ）。

## 0.9.1 (2026-11-15)

実在の技術マニュアルを変換した DM を読み直して見つかった、読み取りの抜けを直しました。読む側は内容を落とさない、という方針（s1000d-stack の DECISIONS D-31）に反していました。

### 修正（`readContent` の結果が変わります）

- **段落の中のリストなどを読みます。** `para`（`notePara`・`warningAndCautionPara`・`simplePara` などを含む）の中にあるブロック要素（`randomList`・`sequentialList`・`definitionList`・`attentionRandomList`・表・図・注意書き）を、その段落の節点の `children` として返します。これまでは文（`text`）に入れず、子としても読まず、`unknownElements` にも `notReadElements` にも数えていませんでした。S1000D ではリストを `para` の中に書くのが普通で、`buildContent` もそう書くので、core で作った DM の箇条書きと用語集が、読むと空の段落になっていました。
- **プロセス DM の `dmNode` が指す DM を返します。** `dmNode` の直下の `dmRef`・`pmRef`・`externalPubRef` を、その節点（`kind: "section"`）の `refs` に入れます。これまでは題名だけを返していました。

節点の数（`countNodes`、outline の `size`）が増えます。型と下書きの形は変えていません。

### テスト

- 本文のテキスト節点が読み取りの結果に残っているかを数えるテストを足しました（`src/content/coverage.spec.test.ts`。配布物を使うので `S1000D_SPEC_TESTS=1` のときだけ動きます）。Bike Samples の 59 件・1,587 個のうち、読み取りの結果に無いテキスト節点は 193 個 → 66 個、1 つも落とさずに読めた DM は 28 件 → 39 件です。残りは、プロセス DM の `displayText`、故障の `faultDescr`、品目の `partNumber` などです。

## 0.9.0 (2026-11-15)

実在の技術マニュアルを使った確認で見つかった、プロセス DM の読み取りの不足を直しました（s1000d-stack の docs/notes/tm-eval-requests.md の RD-1）。既存の API は変えていません（下書きと読み取りの節点に、種類と任意の項目を足しました）。

### 追加

- 下書き（`DraftNode`）の `requirements`（手順・故障探求の本体より前のもの）が、子に `admonition` を受け取ります（docs/notes/tm-eval-requests.md の W-1 のうち、安全の要件の分）。作業全体にかかる警告・注意・備考として、`preliminaryRqmts/reqSafety/safetyRqmts` の `warning` / `caution` / `note` に書きます。これまでは安全の要件を渡す方法が無く、`reqSafety` は必ず `noSafety` でした。
  - XSD の並びに合わせ、入力の位置にかかわらず警告 → 注意 → 備考の順に書きます（並べ替えたときは `notes` に書きます）。
  - 本体より後ろの `requirements`（`closeRqmts`）に `admonition` を置くと `DraftInputError` です（`closeRqmts` に安全の要件の場所が無いため）。
- 下書きの `requirements`（同上）が、人員・参照する文書・品目も受け取ります（W-1 の残り）。節点の種類 `person`・`document`・`equipment`・`supply`・`spare` と、項目 `count`・`quantity`・`unit`・`partNumber`・`manufacturerCode` を足しました（JSON Schema も同じ）。
  - `person` → `reqPersons` の `personnel`（`count` が `@numRequired`）または `person`（`man` があるとき）。`text` が `trade`。
  - `document` → `reqTechInfoGroup/reqTechInfo`。`refs` に `dmRef` か `pmRef` が 1 つあればその参照、無ければ `title`（題名）と `text`（番号）から `externalPubRef`。
  - `equipment`・`supply`・`spare` → `supportEquipDescr`・`supplyDescr`・`spareDescr`（`title` が `name`、`manufacturerCode` と `partNumber` が `identNumber`、`quantity` と `unit` が `reqQuantity`、`text` が `remarks`）。XSD は品目に識別子と `reqQuantity` を要求します。値を補うことはしないので、`manufacturerCode` か `quantity` が無い品目は `DraftInputError` です。
  - 入力に無い必須の区分（支援機材・消耗品・予備品・安全）は、これまでどおり「なし」の要素で埋め、どれを埋めたかを `notes` に書きます。
- `readContent` は、`preliminaryRqmts` の人員・文書・品目・安全の要件を、`requirements` の子の節点として返します（種類と項目は下書きと同じ。`ContentNode` に `count`・`quantity`・`unit`・`partNumber`・`manufacturerCode` を足しました）。`requirements` の `text`（1 つの文にした要約）はこれまでどおりです。
- `readContent` は、共通の警告・注意への参照（`@warningRefs` / `@cautionRefs`）を読みます。これまでは読んでおらず、`safetyRqmts` が参照だけを持つ DM では、`requirements` の要約に安全の要件が何も出ませんでした（`safety: none` も出ない）。手順（`proceduralStep` など）の参照も同じでした。
  - 参照先が同じ DM の `warningsAndCautions` の `warning` / `caution` なら本文を、`warningsAndCautionsRef` の `warningRef` / `cautionRef` なら別の DM への参照（`refs`）と識別番号（`attrs.identNumber`）を、`admonition` の節点として返します。どの節点にも `attrs.referencedId` を付けます。
  - 見つからない id は、`attrs.unresolved` を付けた `admonition` として返します（黙って落としません）。
  - `requirements` の要約には「safety: warning ref w001 (参照先)」の形で入ります。
- `readContent` は、`preliminaryRqmts` / `closeRqmts` の条件を、`requirements` の子の `para` としても返します（`reqCondDm` などの参照は `refs` に入ります。これまでは要約の文にだけ入り、参照は落ちていました）。要約の「persons:」には `personnel`（`@numRequired`）も入ります。
- 配布物のテストに、Bike Samples の `preliminaryRqmts` を「読んで、書いて、失われる要素・属性を数える」テストを足しました（`src/content/requirements.spec.test.ts`）。41 件の DM の要素・属性 2,527 個のうち、最初の実測では 898 個が失われ、下の人員・文書・条件・参照の項目を足した後は 602 個です（何も失わずに往復できる DM は 3 件 → 26 件）。この数を上限として固定し、減らす方向にだけ動かします。
- 下書きと読み取りの `person` に、`man`（あれば `person` 要素、無ければ `personnel`）・`personCategoryCode`・`skillLevelCode`・`estimatedTime`・`estimatedTimeUnit` を足しました。中身の無い `personnel` も書けます。`man` と `count` は一緒に使えません（`person` 要素に人数の属性が無いため）。
- 下書きと読み取りの `document` に `reqTechInfoCategory` を足しました。
- 人員の適用性を `reqPersons/@applicRefId` として読み書きします。XSD では `personnel` / `person` に `applicRefId` が無く、`reqPersons` に付きます。読む側は `reqPersons` の値を人員の節点の `applicRefId` に写し、書く側は同じ `applicRefId` が続く人員を 1 つの `reqPersons` にまとめます。これまで、読む側はこの属性を返さず、書く側は `personnel` に `applicRefId` を書いていました（XSD に通らない XML になる誤りで、未公開のうちに直しました）。
- 参照（`dmRef` / `pmRef`）に、指す版（`issueInfo`）・言語（`language`）・参照自身の `applicRefId` を足しました。`dmRef` には、行き先の DM の中の場所（`fragment` = `@referredFragment`）と、題名の内訳（読む側は `techName`・`infoName`、書く側は `title`・`infoName`）も足しました。読む側（`ContentRef`）と書く側（`DraftRef`）の両方です。これまで、読む側は行き先と題名だけを返していました。
- `readContent` は、条件の区分（`reqCond/@reqCondCategory`）を `attrs.reqCondCategory` に読みます。参照の中の読んでいない要素（`behavior`、外部の文書の発行情報、`identExtension`）も `notReadElements` で知らせます。
- 下書きの条件（`requirements` の子の `para`）が、参照を 1 つ受け取ります。`dmRef` は `reqCondDm`、`pmRef` は `reqCondPm` として書きます（`closeRqmts` でも同じ）。
- `readContent` は、あることは分かっているが中身を読んでいない要素を知らせます。`DataModuleContent.notReadElements`（名前 → 数）と `notes` に入り、該当する節点には `attrs.notRead` が付きます。対象は `productionMaintData`、品目の `identNumber` 以外の識別子（`toolRef`・`partRef`・`supplyRef` など）、入れ子の品目（`embedded…Descr`）、`hazards`、脚注、回路遮断器の一覧です。品目の `shortName`・`@materialUsage`・`@supplyCategory` は `attrs` に読みます。配布物のテストで、Bike Samples の `preliminaryRqmts` に、読まずに黙って落としている要素と属性（構造として読む要素と、参照の中）が無いことを確かめます。

### 変更（数え方が変わります）

- `measureContent` / `outlineContent` の警告の数（`admonitions`）に、`reqSafety/safetyRqmts` の警告・注意・備考が入ります。これまでは要約の文にだけ入り、数に入っていませんでした。節点の数（`nodes`）と文字数（`chars`）にも、`requirements` の子の分が加わります。

### 修正

- `readContent` は、プロセス DM の `dmIf` の条件を読んでいませんでした。`expression` と `variableRef` が `unknown` の節点になり、条件の文が返りませんでした。
  - `dmIf` の節点（`kind: "if"`）の `question` に、`expression/@humanReadableForm` の文を入れます。書く側（`buildContent`）が `DraftNode.question` から作る属性と同じ場所です。
  - 式が変数 1 つを参照するだけのときは、`attrs.variableName` に変数名を入れます。式の中身（演算・値）は評価しません。
  - 条件を読めた `expression` は子の節点に残しません。文が無く、変数 1 つでもない式は、これまでどおり `unknown` として残します。

## 0.8.3 (2026-11-06)

XSD の修正候補の不足を直しました（[#1](https://github.com/shuji-bonji/s1000d-core/issues/1)）。既存の API は変えていません（型に任意の項目を足しただけです）。

### 修正

- 必須の要素が抜けると、libxml2 は次の要素の位置で `This element is not expected. Expected is one of ( … )` と報告します（`dmStatus` の `applic` が抜けると `brexDmRef` で報告される）。この違反から `suggestSchemaFixes` が作る候補は「その要素を取り除く」と「期待された要素に置き換える」だけで、正しい直し方の「前に足す」がありませんでした。
  - 違反の要素が親の中で許される要素（XSD の `allowedChildren` に入っている。XSD が無いときは判定せずに入っているとみなす）で、期待された要素の並びに入っていないとき、期待された要素ごとに `add` の候補（`target` は違反の要素、`value` は足す要素、`position: "before"`）を、置き換える候補より前に足します。`note` に「この要素の前にある要素が抜けている可能性がある」と、親が許す子要素の並びを書きます。`confidence` は従来どおり `several` です。
  - `FixCandidate.position`（`'before'`）を足しました。`applyFix` / `applyFixes` は、`position: "before"` の `add` を、場所の要素の直前に同じ字下げで兄弟として入れます。足した要素は空なので、中身が必須なら検証し直したときに別の違反として出ます（`notes` に書きます）。照合では `position` も一致を求めます。
  - Issue 7 の XSD で、`applic` を抜いた説明 DM に「`brexDmRef` の前に `applic` を足す」候補が付き、適用すると `brexDmRef` の位置の違反が消えることをテストに固定しました（`S1000D_SPEC_TESTS=1`）。

## 0.8.2 (2026-10-29)

hub の E2E テストで見つかった 2 点を直しました。既存の API は変えていません（関数を 1 つ足しただけです）。

### 追加

- `fingerprintDirs(dirs)`（`src/csdb-source.ts`）。フォルダー群の「指紋」を返します。`listCsdbObjects` と同じ範囲（再帰、`node_modules` と `.` で始まるフォルダーは除く、CSDB のファイル名のものだけ）を `readdirSync` と `statSync` だけでたどり、相対パス・大きさ・更新時刻（`mtimeMs`）から SHA-256 を作ります。ファイルの中身は読みません。動き続ける MCP サーバーが、索引を作ったときと今とでフォルダーの中身が変わったか（起動後に増えたファイルがあるか）を確かめて、索引を作り直すのに使います。

### 修正

- `verifyDataModule` は、BREX の工程を行っても照合した層が 0 件で、見つからなかった BREX も無いとき（`brexDmRef` が無く、`extraLayers` も無い）に `brex.state: "passed"` を返していました。何にも照合していないので、`not-run` と `reason`（"no brexDmRef in the document and no BREX layer was given"）にします。`brexDmRef` があるのに見つからないときは、これまでどおり `incomplete` です。`BrexState` の `not-run` の意味は「工程を省いた、または照合した層が 0 件」に広がります。

## 0.8.1 (2026-10-28)

BREX の工程と参照の工程の食い違いを直しました。既存の API は変えていません（型に任意の項目を足しただけです）。

### 修正

- CSDB のフォルダーを渡さず BREX の解決器だけを渡すと、BREX の工程は既定 BREX の層をたどって照合できる（`brex.state: passed`）のに、参照の工程は `brexDmRef` を `no-csdb` で未解決として数え、`suggestFixes` も「CSDB のフォルダーを渡せ」と返していました。CSDB を渡しても、既定 BREX は CSDB ではなく `S1000D_SPEC_DIR` にあるので `not-found` になっていました。
  - `ResolveOptions.knownObjects`（`KnownObject`: `kind: 'brex'`・`dmCode`・`issueInfo?`・`path?`）を足しました。`dmRef` が CSDB に無い（`no-csdb` か `not-found`）とき、同じ DMC がここにあれば解決済みにします。版の照合は CSDB と同じ（`issueInfo` 付きの参照で版が違えば `issueMismatch`）。`ResolvedReference.source`（`'csdb' | 'brex-chain'`）で、どこで見つかったかが分かります。
  - `verifyDataModule` は、BREX の工程でたどれた層（DMC と版）を `knownObjects` に渡します。BREX の工程を省いた（`brex` なし）ときは渡さないので、従来どおり未解決になります。たどれなかった層も未解決のままです。`VerificationStatus.references` の `unresolvedCount` はその分だけ減り、`checked` は変わりません（たどれた層を指す `brexDmRef` だけの文書は `state: resolved` になります）。
  - `suggestFixes` は、モデル識別コード `S1000D` の `dmRef`（仕様書の章への参照）を `no-csdb` より先に判定します。CSDB を渡していなくても「CSDB を渡せ」ではなく、仕様書への参照の注記を返します（`confidence: none`・候補なしは従来どおり）。BREX の層として解決した参照の版が違うときの置き換え提案は、`source: 'BREX chain'` と層の版を示します。

## 0.8.0 (2026-10-28)

段階 3（writer）のための「書く側」の機能です（docs/design/writer-mcp.md、D-27）。既存の API は変えていません。

### 追加

- データモジュールの組み立て（`src/write/`）。`buildDataModule(draft, allocation, options)` が、構造化された入力 `DraftDataModule`（識別情報と、reader の `ContentNode` と同じ語彙の `DraftNode` の木）から識別・状態部と内容部の XML を組み立てます。種類は descript / proced / process / fault / pm の 5 つ（`buildContent`）。`DraftInputError` は XML を組み立てる前の入力の形の検査で、XSD 検証の代わりではありません。proced / fault で必須の前提・事後条件（`preliminaryRqmts` / `closeRqmts`）は、入力に無い項目を `noConds` などで埋め、`qualityAssurance` は `unverified` にします。
- 採番（`src/write/allocate.ts`）。`allocateDmc` / `allocateIcn` / `allocatePmc` が `Allocation`（モデル識別コード・SNS・種類ごとの情報コード `infoCodeByKind`・CAGE）と台帳 `ledger` から番号を決めます。同じ `sourceId` には同じ DMC を返し、台帳は入力で受け取って返します（状態を持たない）。情報コードの既定はありません（D-27）。
- 入力の JSON Schema `schema/draft.schema.json`（`@shuji-bonji/s1000d-core/schema/draft.schema.json`）。型と `required` が一致することをテストで固定しています。
- 修正候補の適用（`src/fix/apply.ts`）。`applyFix` / `applyFixes` が `suggestFixes` の候補（`replace` / `remove` / `add` / `retarget`）を DOM で適用します。`verify` か `offered` で候補を計算し直して照合し、候補に無い選択は `candidate-not-offered` で適用しません（D-19）。`range` / `pattern` の値は `matchesRange` / `matchesPattern` で確かめます。`add` の位置は `XsdIndex` の子要素の順序で決めます。XML 宣言と DOCTYPE（ICN の `ENTITY` / `NOTATION` 宣言）は保ちます（開始タグの中の空白は 1 つに揃います）。
- 書き込める置き場所 `WritableCsdbSource`（`writeText` / `writeBytes`、`isWritableCsdbSource`、`CsdbWriteConflictError`）。`DirectoryCsdbSource`（最初のフォルダーに書く）と `MemoryCsdbSource` に実装しました。同期のままです。
- comment データモジュールの組み立て（`src/comment/`）。`buildComment` が `comment.xsd` の構造（`commentCode` の必須属性 5 つ、`commentAddressItems`、`commentStatus`、`commentContent/simplePara`）に沿って組み立てます。`commentType` / `commentPriorityCode` / `responseType` / `issueType` は列挙のまま解釈しません。`seqNumber` 省略時は CSDB の同じモデル・送り手・年の次の番号です。ファイル名 `COM-<MIC>-<送り手>-<年>-<連番>-<種類>_<言語>-<国>.XML` は配布物の見本 1 件からの推定で、`classifyCsdbFileName` が `comment` として拾います（`CsdbObjectKind` に `comment`）。
- 翻訳向けの文の抜き出しと差し戻し（`src/segments/`）。`extractSegments` が人の読む文（題名・段落・手順・警告・表のセル・図の題名）だけを `Segment[]`（`id`・`xpath`・`context`・`text`・`placeholders`）として返し、インライン要素は `{n}` のプレースホルダーにします。`applySegments` は `skeletonHash` で骨組みが同じことを確かめてから訳文を差し戻し、`language` だけ違う DM を返します（`SkeletonMismatchError`）。Bike Samples 106 件で往復しても元と同じ（空白を除く）で、XSD に適合したままです。
- BREX の連鎖を PM と comment でもたどるようにしました。`readBrexDmRefOf` が `dmStatus` / `pmStatus` / `commentStatus` の `brexDmRef` を読み、`checkAgainstBrexChain` と `verifyDataModule` がそれを使います。`VerificationStatus.target` と `BrexCheckReport.target` に任意の `pmCode` / `commentCode` を足しました。
- `readNonDmIdent` / `readPmCodeElement` / `readCommentCodeElement`、`src/xml/serialize.ts`（宣言と DOCTYPE を保つ直列化）。
- 自作の券売機の入力データ `src/__fixtures__/kenbaiki-drafts.ts`（U-03 の出発点）。

## 0.7.0 (2026-10-28)

### 追加

- 本文の概要と大きさ（`src/content/outline.ts`、段階 2.5 の作業 7、D-19）。`outlineContent` は本文の木から見出し・手順の番号・最初の 1 文（`firstSentence`）・警告の数だけを残した `OutlineNode[]` を返し、`measureContent` は部分木の大きさ `ContentSize`（節点数・文字数・種類ごとの数・警告の数）を返します。LLM が全文を読む前に当たりを付け、読む量の予算を立てるためのものです。残す種類は既定で section / step / requirements / sequence / if / dialog / entry で、`keep`・`maxDepth`・`maxSentenceLength` で変えられます。
- `ContentNode` に `securityClassification`（要素自身の `@securityClassification`。値は解釈しない）を足しました。概要の節点にも付きます。

## 0.6.0 (2026-10-28)

### 追加

- DML（データモジュールリスト）と DDN（納入票）の読み取りと、CSDB との照合（`src/dml/`、段階 2.5 の作業 5、D-19）。`readDml` / `readDdn` が識別・状態部と行（`dmlEntry` の `dmRef` / `pmRef` / `infoEntityRef` / `dmlRef` / `commentRef`、`deliveryListItem` の `dispatchFileName`）を読み、`reconcileDml` / `reconcileDdn` が `found` / `issue-mismatch` / `not-found` / `not-checked` と、CSDB にあるのに DML に載っていない DM・PM（`notListed`）を返します。`dmlType`・`dmlEntryType`・`issueType` は解釈しません。コードとファイル名の分解・組み立ては `parseDmlCode` / `parseDmlFileName` / `formatDmlCode` / `parseDdnCode` / `parseDdnFileName` / `formatDdnCode`。
- `CsdbObject` に `dml` / `ddn`（ファイル名から読めた DML・DDN のコードと発行情報）を足しました。
- `CsdbObjectKind` に `dme`（拡張 DMC のデータモジュール。ファイル名が `DME-` で始まる。Bike Samples に 2 件）を足しました。これまでは索引に入らず、DDN の照合で「無い」と出ていました。`dm` は付かないので `findDataModules` では見つかりません（`findByFileName` では見つかります）。
- `readIssueInfo` を `data-module.ts` から export しました（内部用）。

## 0.5.0 (2026-10-27)

### 追加

- `CsdbSource` インターフェース（`src/csdb-source.ts`、段階 2.5 の作業 3、D-19）。CSDB オブジェクトの「一覧」（`list()`）と「中身の取得」（`readText()`）をここに集め、フォルダー実装 `DirectoryCsdbSource` を既定にしたまま、データベースや API を持つ製品側が自分の実装を差し込めるようにしました。`CsdbIndex.fromSource(source)` で索引を作り、`index.read(object)` で中身を読みます。`CsdbIndex.fromDirs` は `DirectoryCsdbSource` の上に索引を作るようになり、結果は変わりません。
- `MemoryCsdbSource`（ファイル名と XML の組をメモリーに持つ実装）。テストと、先に読み込んだ内容を渡すのに使います。
- `classifyCsdbFileName`（ファイル名から種類と DMC・PMC を決める。`listCsdbObjects` と `MemoryCsdbSource` が共有）。
- `createBrexResolver(index)`（`CsdbIndex` から BREX を探す）。`createDirectoryBrexResolver(dirs)` は `createBrexResolver(CsdbIndex.fromDirs(dirs))` と同じになりました。
- `verifyDataModule` の `references.csdb` に `CsdbSource` を渡せるようにしました（これまでの `CsdbIndex` とフォルダーの一覧も引き続き受け取ります）。

### 変更

- `findApplicTables` と BREX の解決器が、ACT・CCT・PCT・BREX の中身を `readFileSync` ではなく索引の `read()` から読むようになりました。`new CsdbIndex(objects)` で `source` を与えずに作った索引は、これまでどおり `path` をファイルとして読みます。
- `CsdbSource` は同期です。`resolveReferences`・`suggestFixes`・`findApplicTables` が同期関数で、非同期にするとそれらの API を変えることになるためです。非同期にしか読めない置き場所は、先に読み込んで `MemoryCsdbSource` に渡してください。

## 0.4.0 (2026-10-27)

### 追加

- 配布物の場所と CSDB の場所を決める `resolveStackConfig`（`src/stack-config.ts`）。環境変数 `S1000D_SPEC_DIR` / `S1000D_CSDB_DIR` を先に読み、無ければ設定ファイル（既定 `~/.config/s1000d-stack/config.json`、`XDG_CONFIG_HOME` に従う、`S1000D_CONFIG` で変更可）の `specDir` / `csdbDirs` を読みます。Claude Desktop が plugin のサーバーに環境変数を渡さず、plugin の `env` の `${VAR}` も置き換えないため、MCP 3 本が共通に使う入口として足しました。置き換えられずに渡った `${VAR}` は使わず、`warnings` に理由を書きます。

## 0.3.0 (2026-10-27)

段階 2.5 の修正提案（`suggestFixes`）と、BREX の NOTATION の照合の修正。利用側の `^0.2.0` は 0.3.0 を含まないため、依存範囲を `^0.3.0` に上げてください。NOTATION の照合の修正により、除外だけの `notationRuleList` を持つ BREX に照合したときの違反の件数が変わります。

### 追加

- 修正提案（`src/fix/`、段階 2.5 の作業 1、D-19）。`suggestFixes` が `verifyDataModule` の結果から、違反ごとに直し方の候補 `Fix`（`kind` / `location` / `problem` / `candidates[]` / `confidence` / `source`、必要なら `note` と `brSeverityLevel`）を返します。候補は決定論的に決め、点数は付けず、確からしさは `exact` / `several` / `none` の 3 段階です。
  - BREX: 値の違反はルールの `objectValue`（許可値と説明文、`range` / `pattern` は `valueForm` 付き）、禁止は「取り除く」、欠落は「足す」、NOTATION は許可された一覧（`suggestBrexFixes`）。
  - XSD: libxml2 の文章にある値・要素を候補にし、文章に無いもの（型の不一致、`This element is not expected.` だけのもの、許されない属性）は XSD の定義を読んで作ります（`suggestSchemaFixes`）。定義の読み取りは `XsdIndex` / `loadXsdIndex`（`xs:include` / `xs:import` の相対パスをたどる）。
  - 参照: 情報コード・システム差異コードだけ違う DMC、CSDB にある版（`issueMismatch`）、巻だけ違う PMC、拡張子だけ違う ICN、近い id（`suggestReferenceFixes`、`nearMatches` / `editDistance`）。仕様書の章への `dmRef` は候補を作らず説明だけを返します。
  - 適用性: 製品の値が足りず判定不能になった適用性を集め（`findUndeterminedApplicability`）、ACT・CCT・PCT の値を `provide` の候補にします（`suggestApplicabilityFixes`）。
- `findApplicTables`（対象 DM の ACT・CCT・PCT を CSDB から探す）。s1000d-reader-mcp の `services/context.ts` にあった処理を、s1000d-verify-mcp と共有するために移しました。

### 修正

- NOTATION の照合で、許可（`allowedNotationFlag="1"`）が 1 つも無く除外（`"0"`）だけの BREX の層を「使ってよい NOTATION が 0 件」と読み、使われているすべての NOTATION を違反にしていた誤りを直しました。Issue 7 Chap 4.10.2.2 Para 2.2.2 のとおり `allowedNotationFlag` は基本セットに対する相対的な宣言で、基本セットを BREX で決めないときは BREX 以外の手段で範囲を決めるとされているため、この層は「挙げたものだけを違反にし、それ以外は制限しない」と読みます。判定は新しい `notationPolicy`（`closed` / `open`）で行い、`allowedNotations` は集合が決まらないとき `undefined` を返します（以前は空の集合）。Bike Samples では、Flash を除外するルール 1 件だけを持つ BREX のために出ていた NOTATION の違反 36 件が 0 件になりました。除外だけの層での NOTATION の違反には `allowedValues` が付きません。
- `findSchemaDirs` が配布物のデータ辞書（`data_dictionary_*/Files/xml_schema_flat/`）の XSD を候補に入れないようにしました。この写しは `xml.xsd` などを `http://www.w3.org/2001/xml.xsd` の絶対 URL で import しており、libxml2 がネットワークに出ようとして失敗します。「XML Schema Package」側（相対パスで import）だけを使います。

## 0.2.0 (2026-10-25)

段階 2（reader / verify）の土台。XSD 検証・参照の解決・適用性の評価・本文の読み取りを追加しました。利用側の `^0.1.0` は 0.2.0 を含まないため、依存範囲を `^0.2.0` に上げてください。

### 追加

- BREX の所在の解決（`locateBrex` / `findDefaultBrex` / `isDefaultBrexDmc` / `BrexLocateError`）。s1000d-brex-mcp にあった「ファイルのパス・DMC・省略（配布物の既定 BREX）のどれで指定されても BREX を 1 つ決める」処理を、s1000d-verify-mcp と共有するために移しました。既定 BREX は `DMC-S1000D-*-04-10-0301-00A-022A-D` をシステム差異コードを見ずに探し、中身の DMC がファイル名と一致して自分自身を参照するものを優先します。見つからない理由は `BrexLocateError.reason`（`default-not-found` / `file-not-found` / `not-brex` / `invalid-spec` / `dmc-not-found`）で返します。
- XML スキーマ（XSD）による検証（D-15、D-17）。インターフェース `SchemaValidator` と、`libxml2-wasm` による実装 `Libxml2SchemaValidator`（サブパス `@shuji-bonji/s1000d-core/xsd-libxml2`。`libxml2-wasm` は任意の peerDependency）。XSD ごとに 1 つコンパイルして使い回し、Issue 7 の Bike Samples 106 件を 0.5 秒以内で検証します。
- 配布物の中の `xml_schema_flat/` の探索（`findSchemaDirs`。版は `brex.xsd` 冒頭の `Issue number:` から読む）と、`xsi:noNamespaceSchemaLocation` から使う XSD を決める `locateXsd`。
- 検証状態 `VerificationStatus` と、整形式・XSD・BREX をまとめて行う `verifyDataModule`。s1000d-verify-mcp と s1000d-reader-mcp が同じ形で検証状態を返すための土台です。
- 参照の解決（`collectReferences` / `resolveReferences`、`verifyDataModule` の `references`）。`dmRef`（brexDmRef・applicCrossRefTableRef・pmEntry などすべての文脈）、`pmRef`、ICN（`@infoEntityIdent` → DOCTYPE の `ENTITY` 宣言 → ファイル）、`internalRef`、`applicRefId`（`applic/@id` と `referencedApplicGroupRef/applicRef/@id` の両方）を集め、参照先の有無を理由付きで返します。`issueInfo` 付きの参照は版の一致も見て、違えば `issueMismatch` を付けます。
- 本文の読み取り（`src/content/`。`readContent` / `readContentFromXml` / `countNodes`）。`descript` / `proced` / `process` / `fault` / `pm` の 5 種の内容部を、共通の形 `ContentNode` の木（section / para / list / table / figure / admonition / step / requirements / sequence / if / dialog / entry）に揃えます。手順の番号（1、1.1）を組み立て、段落の中の参照は `[→ DMC 題名]` の形で文に埋め込みつつ `refs` にも集めます。知らない要素は捨てず `unknown` として残し、名前と数を `unknownElements` に返します。他の種類は `kind: 'other'` で識別・状態部だけを対象にします。
- 適用性の評価（`src/applic/`）。ACT・CCT・PCT の読み取り（`readAct` / `readCct` / `readPct` / `productFromPct`）、`applic` の読み取り（`readApplicStatements`）、`assert` / `evaluate` の 3 値評価（`evaluateApplic` / `evaluateExpr`。applicable / notApplicable / undetermined）、データモジュール 1 件分の評価器 `ApplicEvaluator`（DM 全体の applic と要素の `@applicRefId` を and で結ぶ。`referencedApplicGroupRef/applicRef/@applicIdentValue` で別 DM の適用性リポジトリを指す形も `buildApplicRepository` で扱う）。値の照合は BREX と同じ `matchesRange`（単一値・`|`・`a~b`）。
- PMC の分解・組み立て（`parsePmc` / `formatPmc` / `parsePmcFileName` / `samePmc`）と、DMC 以外（PMC・DML・DDN・IMF・UPF・ICN）も拾う CSDB の索引（`listCsdbObjects` / `CsdbIndex`）。

### 変更

- `package.json` の `exports` にサブパス `./xsd-libxml2` を追加。`libxml2-wasm` を任意の `peerDependencies` に追加（XSD 検証を使うときだけ入れる）。
- 既存の API は変えていません。

## 0.1.0 (2026-10-24)

最初の公開。S1000D® の CSDB オブジェクトを読み、BREX に照合するための土台です。

### 追加

- DMC の分解・組み立て（`parseDmc` / `formatDmc` / `parseDmcFileName` / `formatDmcFileName` / `sameDmc` / `isBrexDmc`）
- ICN（MIC 基準・CAGE 基準）の分解・組み立て（`parseIcn` / `formatIcn` / `parseIcnFileName`）
- `xsi:noNamespaceSchemaLocation` からのスキーマ名と版の推定（`parseSchemaLocation`）
- データモジュールの識別・状態部の読み取り（`readDataModuleInfo` / `readIdentAndStatus` / `readDmRef`）
- BREX データモジュールの読み取り（`readBrex`）と SNS 検索（`lookupSns`）
- BREX への照合: 1 層・複数層・`brexDmRef` の連鎖（`checkAgainstBrexLayer` / `checkAgainstBrexLayers` / `checkAgainstBrexChain` / `resolveBrexChain`）。Issue 7 Chap 4.10.2 と Chap 7.9 の規則に沿い、各層を個別に照合する
- フォルダーを CSDB と見なす解決器（`listDataModules` / `findDataModule` / `createDirectoryBrexResolver`）
- XML の読み取りと XPath 3.1 の評価（`XmlEngine` / `defaultXmlEngine`。実装は `@xmldom/xmldom` ＋ `fontoxpath`）

### 注記

- S1000D の仕様書・スキーマ・公式サンプルは含みません。配布物を使うテスト（`npm run test:spec`）は利用者が入手したものを `S1000D_SPEC_DIR` から読みます。
- XML スキーマ（XSD）による検証は含みません。
