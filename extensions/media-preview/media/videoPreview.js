/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
"use strict";

(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	function getSettings() {
		const element = document.getElementById('settings');
		if (element) {
			const data = element.getAttribute('data-settings');
			if (data) {
				return JSON.parse(data);
			}
		}

		throw new Error(`Could not load settings`);
	}

	/**
	 * Validates and sanitizes a URL to ensure it is safe for use.
	 * @param {string} url The URL to validate.
	 * @returns {string} A sanitized URL or an empty string if invalid.
	 */
	function sanitizeUrl(url) {
		try {
			const parsedUrl = new URL(url, document.baseURI);
			// Allow only specific protocols (e.g., http, https)
			if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
				return parsedUrl.href;
			}
		} catch {
			// Invalid URL
		}
		return '';
	}

	const settings = getSettings();

	// State
	let hasLoadedMedia = false;

	// Elements
	const video = document.createElement('video');
	if (settings.src !== null) {
		video.src = sanitizeUrl(settings.src);
	}
	video.playsInline = true;
	video.controls = true;
	video.autoplay = settings.autoplay;
	video.muted = settings.autoplay;
	video.loop = settings.loop;

	function onLoaded() {
		if (hasLoadedMedia) {
			return;
		}
		hasLoadedMedia = true;

		document.body.classList.remove('loading');
		document.body.classList.add('ready');
		document.body.append(video);
	}

	video.addEventListener('error', e => {
		if (hasLoadedMedia) {
			return;
		}

		hasLoadedMedia = true;
		document.body.classList.add('error');
		document.body.classList.remove('loading');
	});

	if (settings.src === null) {
		onLoaded();
	} else {
		video.addEventListener('canplaythrough', () => {
			onLoaded();
		});
	}

	document.querySelector('.open-file-link')?.addEventListener('click', (e) => {
		e.preventDefault();
		vscode.postMessage({
			type: 'reopen-as-text',
		});
	});
}());
