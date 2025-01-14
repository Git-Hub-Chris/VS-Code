/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Parser } from '@vscode/tree-sitter-wasm';
import { AppResourcePath, FileAccess, nodeModulesAsarUnpackedPath, nodeModulesPath } from '../../../../base/common/network.js';
import { EDITOR_EXPERIMENTAL_PREFER_TREESITTER, ITreeSitterParserService, ITreeSitterParseResult, ITextModelTreeSitter, RangeChange } from '../treeSitterParserService.js';
import { IModelService } from '../model.js';
import { Disposable, DisposableMap, DisposableStore, dispose, IDisposable } from '../../../../base/common/lifecycle.js';
import { ITextModel } from '../../model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IModelContentChange } from '../../textModelEvents.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { setTimeout0 } from '../../../../base/common/platform.js';
import { canASAR, importAMDNodeModule } from '../../../../amdX.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationToken, cancelOnDispose } from '../../../../base/common/cancellation.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { PromiseResult } from '../../../../base/common/observable.js';
import { Range } from '../../core/range.js';

const EDITOR_TREESITTER_TELEMETRY = 'editor.experimental.treeSitterTelemetry';
const MODULE_LOCATION_SUBPATH = `@vscode/tree-sitter-wasm/wasm`;
const FILENAME_TREESITTER_WASM = `tree-sitter.wasm`;

function getModuleLocation(environmentService: IEnvironmentService): AppResourcePath {
	return `${(canASAR && environmentService.isBuilt) ? nodeModulesAsarUnpackedPath : nodeModulesPath}/${MODULE_LOCATION_SUBPATH}`;
}

export class TextModelTreeSitter extends Disposable implements ITextModelTreeSitter {
	private _onDidChangeParseResult: Emitter<RangeChange[]> = this._register(new Emitter<RangeChange[]>());
	public readonly onDidChangeParseResult: Event<RangeChange[]> = this._onDidChangeParseResult.event;
	private _parseResult: TreeSitterParseResult | undefined;

	get parseResult(): ITreeSitterParseResult | undefined { return this._parseResult; }

	constructor(readonly model: ITextModel,
		private readonly _treeSitterLanguages: TreeSitterLanguages,
		private readonly _treeSitterImporter: TreeSitterImporter,
		private readonly _logService: ILogService,
		private readonly _telemetryService: ITelemetryService,
		parseImmediately: boolean = true
	) {
		super();
		if (parseImmediately) {
			this._register(Event.runAndSubscribe(this.model.onDidChangeLanguage, (e => this._onDidChangeLanguage(e ? e.newLanguage : this.model.getLanguageId()))));
		} else {
			this._register(this.model.onDidChangeLanguage(e => this._onDidChangeLanguage(e ? e.newLanguage : this.model.getLanguageId())));
		}
	}

	private readonly _languageSessionDisposables = this._register(new DisposableStore());
	/**
	 * Be very careful when making changes to this method as it is easy to introduce race conditions.
	 */
	private async _onDidChangeLanguage(languageId: string) {
		this.parse(languageId);
	}

	public async parse(languageId: string = this.model.getLanguageId()): Promise<ITreeSitterParseResult | undefined> {
		this._languageSessionDisposables.clear();
		this._parseResult = undefined;

		const token = cancelOnDispose(this._languageSessionDisposables);
		let language: Parser.Language | undefined;
		try {
			language = await this._getLanguage(languageId, token);
		} catch (e) {
			if (isCancellationError(e)) {
				return;
			}
			throw e;
		}

		const Parser = await this._treeSitterImporter.getParserClass();
		if (token.isCancellationRequested) {
			return;
		}

		const treeSitterTree = this._languageSessionDisposables.add(new TreeSitterParseResult(new Parser(), language, this._logService, this._telemetryService));
		this._parseResult = treeSitterTree;
		this._languageSessionDisposables.add(this.model.onDidChangeContent(e => this._onDidChangeContent(treeSitterTree, e.changes)));
		await this._onDidChangeContent(treeSitterTree, []);
		if (token.isCancellationRequested) {
			return;
		}

		return this._parseResult;
	}

	private _getLanguage(languageId: string, token: CancellationToken): Promise<Parser.Language> {
		const language = this._treeSitterLanguages.getOrInitLanguage(languageId);
		if (language) {
			return Promise.resolve(language);
		}
		const disposables: IDisposable[] = [];

		return new Promise((resolve, reject) => {
			disposables.push(this._treeSitterLanguages.onDidAddLanguage(e => {
				if (e.id === languageId) {
					dispose(disposables);
					resolve(e.language);
				}
			}));
			token.onCancellationRequested(() => {
				dispose(disposables);
				reject(new CancellationError());
			}, undefined, disposables);
		});
	}

	private async _onDidChangeContent(treeSitterTree: TreeSitterParseResult, changes: IModelContentChange[]) {
		const changedNodes = await treeSitterTree.onDidChangeContent(this.model, changes);
		// Tree sitter is 0 based, text model is 1 based
		const ranges: RangeChange[] = changedNodes ?? [{ newRange: this.model.getFullModelRange(), oldRangeLength: this.model.getValueLength() }];
		this._onDidChangeParseResult.fire(ranges);
	}
}

const enum TelemetryParseType {
	Full = 'fullParse',
	Incremental = 'incrementalParse'
}

export class TreeSitterParseResult implements IDisposable, ITreeSitterParseResult {
	private _tree: Parser.Tree | undefined;
	private _isDisposed: boolean = false;
	constructor(public readonly parser: Parser,
		public /** exposed for tests **/ readonly language: Parser.Language,
		private readonly _logService: ILogService,
		private readonly _telemetryService: ITelemetryService) {
		this.parser.setTimeoutMicros(50 * 1000); // 50 ms
		this.parser.setLanguage(language);
	}
	dispose(): void {
		this._isDisposed = true;
		this._tree?.delete();
		this.parser?.delete();
	}
	get tree() { return this._tree; }
	private set tree(newTree: Parser.Tree | undefined) {
		this._tree?.delete();
		this._tree = newTree;
	}
	get isDisposed() { return this._isDisposed; }

	private findChangedNodes(newTree: Parser.Tree, oldTree: Parser.Tree) {
		const newCursor = newTree.walk();
		const oldCursor = oldTree.walk();
		const gotoNextSibling = () => {
			const n = newCursor.gotoNextSibling();
			const o = oldCursor.gotoNextSibling();
			if (n !== o) {
				throw new Error('Trees are out of sync');
			}
			return n && o;
		};
		const gotoParent = () => {
			const n = newCursor.gotoParent();
			const o = oldCursor.gotoParent();
			if (n !== o) {
				throw new Error('Trees are out of sync');
			}
			return n && o;
		};
		const gotoFirstChild = () => {
			const n = newCursor.gotoFirstChild();
			const o = oldCursor.gotoFirstChild();
			if (n !== o) {
				throw new Error('Trees are out of sync');
			}
			return n && o;
		};

		const changedNodes: { new: Parser.SyntaxNode; old: Parser.SyntaxNode }[] = [];
		let next = true;
		const nextSiblingOrParentSibling = () => {
			do {
				if (newCursor.currentNode.nextSibling) {
					return gotoNextSibling();
				}
				if (newCursor.currentNode.parent) {
					gotoParent();
				}
			} while (newCursor.currentNode.nextSibling || newCursor.currentNode.parent);
			return false;
		};

		do {
			let canGoChild = newCursor.currentNode.childCount > 0;
			if (newCursor.currentNode.hasChanges && newCursor.currentNode.id !== newTree.rootNode.id) {
				changedNodes.push({ new: newCursor.currentNode, old: oldCursor.currentNode });
				canGoChild = false;
			}
			next = canGoChild ? gotoFirstChild() : nextSiblingOrParentSibling();
		} while (next);
		return changedNodes;
	}

	private calculateRangeChange(changedNodes: { new: Parser.SyntaxNode; old: Parser.SyntaxNode }[] | undefined): RangeChange[] | undefined {
		if (!changedNodes) {
			return undefined;
		}
		const ranges: RangeChange[] = changedNodes.map((node) => {

			const newRange = new Range(node.new.startPosition.row + 1, node.new.startPosition.column + 1, node.new.endPosition.row + 1, node.new.endPosition.column + 1);
			const oldRangeLength = node.old.endIndex - node.old.startIndex;
			return { newRange, oldRangeLength };
		});
		return ranges;
	}

	private _onDidChangeContentQueue: Promise<void> = Promise.resolve();
	public async onDidChangeContent(model: ITextModel, changes: IModelContentChange[]): Promise<RangeChange[] | undefined> {
		const oldTree = this.tree?.copy();
		this._applyEdits(model, changes);
		let changedNodes: RangeChange[] | undefined = undefined;
		if (this.tree && oldTree) {
			// The nodes from the old tree that have changed
			changedNodes = this.calculateRangeChange(this.findChangedNodes(this.tree, oldTree));
		}

		return new Promise(resolve => {
			this._onDidChangeContentQueue = this._onDidChangeContentQueue.then(async () => {
				if (this.isDisposed) {
					// No need to continue the queue if we are disposed
					return;
				}
				await this._parseAndUpdateTree(model);
				resolve(changedNodes);
			}).catch((e) => {
				this._logService.error('Error parsing tree-sitter tree', e);
			});
		});
	}

	private _newEdits = true;
	private _applyEdits(model: ITextModel, changes: IModelContentChange[]) {
		for (const change of changes) {
			const newEndOffset = change.rangeOffset + change.text.length;
			const newEndPosition = model.getPositionAt(newEndOffset);

			this.tree?.edit({
				startIndex: change.rangeOffset,
				oldEndIndex: change.rangeOffset + change.rangeLength,
				newEndIndex: change.rangeOffset + change.text.length,
				startPosition: { row: change.range.startLineNumber - 1, column: change.range.startColumn - 1 },
				oldEndPosition: { row: change.range.endLineNumber - 1, column: change.range.endColumn - 1 },
				newEndPosition: { row: newEndPosition.lineNumber - 1, column: newEndPosition.column - 1 }
			});
			this._newEdits = true;
		}
	}

	private async _parseAndUpdateTree(model: ITextModel) {
		const tree = await this._parse(model);
		if (!this._newEdits) {
			this.tree = tree;
		}
	}

	private _parse(model: ITextModel): Promise<Parser.Tree | undefined> {
		let parseType: TelemetryParseType = TelemetryParseType.Full;
		if (this.tree) {
			parseType = TelemetryParseType.Incremental;
		}
		return this._parseAndYield(model, parseType);
	}

	private async _parseAndYield(model: ITextModel, parseType: TelemetryParseType): Promise<Parser.Tree | undefined> {
		const language = model.getLanguageId();
		let tree: Parser.Tree | undefined;
		let time: number = 0;
		let passes: number = 0;
		this._newEdits = false;
		do {
			const timer = performance.now();
			try {
				tree = this.parser.parse((index: number, position?: Parser.Point) => this._parseCallback(model, index), this.tree);
			} catch (e) {
				// parsing can fail when the timeout is reached, will resume upon next loop
			} finally {
				time += performance.now() - timer;
				passes++;
			}

			// Even if the model changes and edits are applied, the tree parsing will continue correctly after the await.
			await new Promise<void>(resolve => setTimeout0(resolve));

			if (model.isDisposed() || this.isDisposed) {
				return;
			}
		} while (!tree && !this._newEdits); // exit if there a new edits, as anhy parsing done while there are new edits is throw away work
		this.sendParseTimeTelemetry(parseType, language, time, passes);
		return tree;
	}

	private _parseCallback(textModel: ITextModel, index: number): string | null {
		try {
			return textModel.getTextBuffer().getNearestChunk(index);
		} catch (e) {
			this._logService.debug('Error getting chunk for tree-sitter parsing', e);
		}
		return null;
	}

	private sendParseTimeTelemetry(parseType: TelemetryParseType, languageId: string, time: number, passes: number): void {
		this._logService.debug(`Tree parsing (${parseType}) took ${time} ms and ${passes} passes.`);
		type ParseTimeClassification = {
			owner: 'alros';
			comment: 'Used to understand how long it takes to parse a tree-sitter tree';
			languageId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The programming language ID.' };
			time: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The ms it took to parse' };
			passes: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The number of passes it took to parse' };
		};
		if (parseType === TelemetryParseType.Full) {
			this._telemetryService.publicLog2<{ languageId: string; time: number; passes: number }, ParseTimeClassification>(`treeSitter.fullParse`, { languageId, time, passes });
		} else {
			this._telemetryService.publicLog2<{ languageId: string; time: number; passes: number }, ParseTimeClassification>(`treeSitter.incrementalParse`, { languageId, time, passes });
		}
	}
}

export class TreeSitterLanguages extends Disposable {
	private _languages: AsyncCache<string, Parser.Language | undefined> = new AsyncCache();
	public /*exposed for tests*/ readonly _onDidAddLanguage: Emitter<{ id: string; language: Parser.Language }> = this._register(new Emitter());
	/**
	 * If you're looking for a specific language, make sure to check if it already exists with `getLanguage` as it will kick off the process to add it if it doesn't exist.
	 */
	public readonly onDidAddLanguage: Event<{ id: string; language: Parser.Language }> = this._onDidAddLanguage.event;

	constructor(private readonly _treeSitterImporter: TreeSitterImporter,
		private readonly _fileService: IFileService,
		private readonly _environmentService: IEnvironmentService,
		private readonly _registeredLanguages: Map<string, string>,
	) {
		super();
	}

	public getOrInitLanguage(languageId: string): Parser.Language | undefined {
		if (this._languages.isCached(languageId)) {
			return this._languages.getSyncIfCached(languageId);
		} else {
			// kick off adding the language, but don't wait
			this._addLanguage(languageId);
			return undefined;
		}
	}

	public async getLanguage(languageId: string): Promise<Parser.Language | undefined> {
		if (this._languages.isCached(languageId)) {
			return this._languages.getSyncIfCached(languageId);
		} else {
			await this._addLanguage(languageId);
			return this._languages.get(languageId);
		}
	}

	private async _addLanguage(languageId: string): Promise<void> {
		const languagePromise = this._languages.get(languageId);
		if (!languagePromise) {
			this._languages.set(languageId, this._fetchLanguage(languageId));
			const language = await this._languages.get(languageId);
			if (!language) {
				return undefined;
			}
			this._onDidAddLanguage.fire({ id: languageId, language });
		}
	}

	private async _fetchLanguage(languageId: string): Promise<Parser.Language | undefined> {
		const grammarName = this._registeredLanguages.get(languageId);
		const languageLocation = this._getLanguageLocation(languageId);
		if (!grammarName || !languageLocation) {
			return undefined;
		}
		const wasmPath: AppResourcePath = `${languageLocation}/${grammarName}.wasm`;
		const languageFile = await (this._fileService.readFile(FileAccess.asFileUri(wasmPath)));
		const Parser = await this._treeSitterImporter.getParserClass();
		return Parser.Language.load(languageFile.value.buffer);
	}

	private _getLanguageLocation(languageId: string): AppResourcePath | undefined {
		const grammarName = this._registeredLanguages.get(languageId);
		if (!grammarName) {
			return undefined;
		}
		return getModuleLocation(this._environmentService);
	}
}

export class TreeSitterImporter {
	private _treeSitterImport: typeof import('@vscode/tree-sitter-wasm') | undefined;
	private async _getTreeSitterImport() {
		if (!this._treeSitterImport) {
			this._treeSitterImport = await importAMDNodeModule<typeof import('@vscode/tree-sitter-wasm')>('@vscode/tree-sitter-wasm', 'wasm/tree-sitter.js');
		}
		return this._treeSitterImport;
	}

	private _parserClass: typeof Parser | undefined;
	public async getParserClass() {
		if (!this._parserClass) {
			this._parserClass = (await this._getTreeSitterImport()).Parser;
		}
		return this._parserClass;
	}
}

interface TextModelTreeSitterItem {
	dispose(): void;
	textModelTreeSitter: TextModelTreeSitter;
	disposables: DisposableStore;
}

export class TreeSitterTextModelService extends Disposable implements ITreeSitterParserService {
	readonly _serviceBrand: undefined;
	private _init!: Promise<boolean>;
	private _textModelTreeSitters: DisposableMap<ITextModel, TextModelTreeSitterItem> = this._register(new DisposableMap());
	private readonly _registeredLanguages: Map<string, string> = new Map();
	private readonly _treeSitterImporter: TreeSitterImporter = new TreeSitterImporter();
	private readonly _treeSitterLanguages: TreeSitterLanguages;

	public readonly onDidAddLanguage: Event<{ id: string; language: Parser.Language }>;
	private _onDidUpdateTree: Emitter<{ textModel: ITextModel; ranges: RangeChange[] }> = this._register(new Emitter());
	public readonly onDidUpdateTree: Event<{ textModel: ITextModel; ranges: RangeChange[] }> = this._onDidUpdateTree.event;

	public isTest: boolean = false;

	constructor(@IModelService private readonly _modelService: IModelService,
		@IFileService fileService: IFileService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService
	) {
		super();
		this._treeSitterLanguages = this._register(new TreeSitterLanguages(this._treeSitterImporter, fileService, this._environmentService, this._registeredLanguages));
		this.onDidAddLanguage = this._treeSitterLanguages.onDidAddLanguage;
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(EDITOR_EXPERIMENTAL_PREFER_TREESITTER)) {
				this._supportedLanguagesChanged();
			}
		}));
		this._supportedLanguagesChanged();
	}

	getOrInitLanguage(languageId: string): Parser.Language | undefined {
		return this._treeSitterLanguages.getOrInitLanguage(languageId);
	}

	getParseResult(textModel: ITextModel): ITreeSitterParseResult | undefined {
		const textModelTreeSitter = this._textModelTreeSitters.get(textModel);
		return textModelTreeSitter?.textModelTreeSitter.parseResult;
	}

	/**
	 * For testing
	 */
	async getTree(content: string, languageId: string): Promise<Parser.Tree | undefined> {
		const language = await this.getLanguage(languageId);
		const Parser = await this._treeSitterImporter.getParserClass();
		if (language) {
			const parser = new Parser();
			parser.setLanguage(language);
			return parser.parse(content);
		}
		return undefined;
	}

	/**
	 * For testing
	 */
	async getLanguage(languageId: string): Promise<Parser.Language | undefined> {
		await this._init;
		return this._treeSitterLanguages.getLanguage(languageId);
	}

	private async _doInitParser() {
		const Parser = await this._treeSitterImporter.getParserClass();
		const environmentService = this._environmentService;
		const isTest = this.isTest;
		await Parser.init({
			locateFile(_file: string, _folder: string) {
				const location: AppResourcePath = `${getModuleLocation(environmentService)}/${FILENAME_TREESITTER_WASM}`;
				if (isTest) {
					return FileAccess.asFileUri(location).toString(true);
				} else {
					return FileAccess.asBrowserUri(location).toString(true);
				}
			}
		});
		return true;
	}

	private _hasInit: boolean = false;
	private async _initParser(hasLanguages: boolean): Promise<boolean> {
		if (this._hasInit) {
			return this._init;
		}

		if (hasLanguages) {
			this._hasInit = true;
			this._init = this._doInitParser();

			// New init, we need to deal with all the existing text models and set up listeners
			this._init.then(() => this._registerModelServiceListeners());
		} else {
			this._init = Promise.resolve(false);
		}
		return this._init;
	}

	private async _supportedLanguagesChanged() {
		const setting = this._getSetting();

		let hasLanguages = true;
		if (setting.length === 0) {
			hasLanguages = false;
		}
		// Eventually, this should actually use an extension point to add tree sitter grammars, but for now they are hard coded in core
		if (setting.includes('typescript')) {
			this._addGrammar('typescript', 'tree-sitter-typescript');
		} else {
			this._removeGrammar('typescript');
		}

		return this._initParser(hasLanguages);
	}

	private _getSetting(): string[] {
		const setting = this._configurationService.getValue<string[]>(EDITOR_EXPERIMENTAL_PREFER_TREESITTER);
		if (setting && setting.length > 0) {
			return setting;
		} else {
			const expSetting = this._configurationService.getValue<boolean>(EDITOR_TREESITTER_TELEMETRY);
			if (expSetting) {
				return ['typescript'];
			}
		}
		return [];
	}

	private async _registerModelServiceListeners() {
		this._register(this._modelService.onModelAdded(model => {
			this._createTextModelTreeSitter(model);
		}));
		this._register(this._modelService.onModelRemoved(model => {
			this._textModelTreeSitters.deleteAndDispose(model);
		}));
		this._modelService.getModels().forEach(model => this._createTextModelTreeSitter(model));
	}

	public async getTextModelTreeSitter(model: ITextModel, parseImmediately: boolean = false): Promise<ITextModelTreeSitter> {
		await this.getLanguage(model.getLanguageId());
		return this._createTextModelTreeSitter(model, parseImmediately);
	}

	private _createTextModelTreeSitter(model: ITextModel, parseImmediately: boolean = true): ITextModelTreeSitter {
		const textModelTreeSitter = new TextModelTreeSitter(model, this._treeSitterLanguages, this._treeSitterImporter, this._logService, this._telemetryService, parseImmediately);
		const disposables = new DisposableStore();
		disposables.add(textModelTreeSitter);
		disposables.add(textModelTreeSitter.onDidChangeParseResult((ranges) => this._onDidUpdateTree.fire({ textModel: model, ranges })));
		this._textModelTreeSitters.set(model, {
			textModelTreeSitter,
			disposables,
			dispose: disposables.dispose.bind(disposables)
		});
		return textModelTreeSitter;
	}

	private _addGrammar(languageId: string, grammarName: string) {
		if (!this._registeredLanguages.has(languageId)) {
			this._registeredLanguages.set(languageId, grammarName);
		}
	}

	private _removeGrammar(languageId: string) {
		if (this._registeredLanguages.has(languageId)) {
			this._registeredLanguages.delete('typescript');
		}
	}
}

class PromiseWithSyncAccess<T> {
	private _result: PromiseResult<T> | undefined;
	/**
	 * Returns undefined if the promise did not resolve yet.
	 */
	get result(): PromiseResult<T> | undefined {
		return this._result;
	}

	constructor(public readonly promise: Promise<T>) {
		promise.then(result => {
			this._result = new PromiseResult(result, undefined);
		}).catch(e => {
			this._result = new PromiseResult<T>(undefined, e);
		});
	}
}

class AsyncCache<TKey, T> {
	private readonly _values = new Map<TKey, PromiseWithSyncAccess<T>>();

	set(key: TKey, promise: Promise<T>) {
		this._values.set(key, new PromiseWithSyncAccess(promise));
	}

	get(key: TKey): Promise<T> | undefined {
		return this._values.get(key)?.promise;
	}

	getSyncIfCached(key: TKey): T | undefined {
		return this._values.get(key)?.result?.data;
	}

	isCached(key: TKey): boolean {
		return this._values.get(key)?.result !== undefined;
	}
}
