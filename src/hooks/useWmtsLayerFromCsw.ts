import { useEffect, useRef, useState } from 'react';
import TileLayer from 'ol/layer/Tile';
import TileState from 'ol/TileState';
import WMTS, { optionsFromCapabilities } from 'ol/source/WMTS';
import WMTSCapabilities from 'ol/format/WMTSCapabilities';
import type OlMap from 'ol/Map';

type UseWmtsLayerFromCswParams = {
	mapRef: React.RefObject<OlMap | null>;
	selectedLayers: string[];
	wmtsMetadataByLayerId: Map<
		string,
		{ capabilitiesUrl: string; wmtsLayerId: string }
	>;
	apiKey?: string;
	enabled?: boolean;
};

type UseWmtsLayerFromCswResult = {
	error: string;
};

const capabilitiesCache = new Map<string, Record<string, any>>();
const capabilitiesPromiseCache = new Map<string, Promise<Record<string, any>>>();

const loadCapabilities = async (url: string, apiKey?: string) => {
	const cacheKey = `${url}::${apiKey ?? ''}`;
	let parsed = capabilitiesCache.get(cacheKey);
	if (parsed) return parsed;
	let inFlight = capabilitiesPromiseCache.get(cacheKey);
	if (!inFlight) {
		inFlight = fetch(url, {
			headers: apiKey ? { 'x-api-key': apiKey } : undefined,
		})
			.then((response) => {
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				return response.text();
			})
			.then((text) => {
				const parser = new WMTSCapabilities();
				return parser.read(text) as Record<string, any>;
			});
		capabilitiesPromiseCache.set(cacheKey, inFlight);
	}
	parsed = await inFlight;
	capabilitiesCache.set(cacheKey, parsed);
	return parsed;
};

export function useWmtsLayerFromCsw({
	mapRef,
	selectedLayers,
	wmtsMetadataByLayerId,
	apiKey,
	enabled = true,
}: UseWmtsLayerFromCswParams): UseWmtsLayerFromCswResult {
	const layerMapRef = useRef<Map<string, TileLayer<WMTS>>>(new Map());
	const [error, setError] = useState('');

	useEffect(() => {
		const map = mapRef.current;
		if (!map) return;
		if (!enabled || selectedLayers.length === 0) {
			layerMapRef.current.forEach((layer: TileLayer<WMTS>) =>
				map.removeLayer(layer),
			);
			layerMapRef.current.clear();
			setError('');
			return;
		}

		const nextLayerIds = new Set(selectedLayers);
		layerMapRef.current.forEach((layer: TileLayer<WMTS>, layerId) => {
			if (!nextLayerIds.has(layerId)) {
				map.removeLayer(layer);
				layerMapRef.current.delete(layerId);
			}
		});

		let active = true;
		const updateLayers = async () => {
			setError('');
			await Promise.all(
				selectedLayers.map(async (layerId) => {
					const wmtsMetadata = wmtsMetadataByLayerId.get(layerId);
					if (!wmtsMetadata?.capabilitiesUrl) {
						const existingLayer = layerMapRef.current.get(layerId);
						if (existingLayer) {
							map.removeLayer(existingLayer);
							layerMapRef.current.delete(layerId);
						}
						if (active) {
							setError(
								`WMTS capabilities URL not found for layer ${layerId}.`,
							);
						}
						return;
					}
					try {
						const capabilities = await loadCapabilities(
							wmtsMetadata.capabilitiesUrl,
							apiKey,
						);
						if (!active) return;
						const capabilityLayers =
							(capabilities?.Contents?.Layer ?? []) as {
								Identifier: string;
								TileMatrixSetLink?: { TileMatrixSet: string }[];
							}[];
						const wmtsLayerId =
							wmtsMetadata.wmtsLayerId || layerId;
						const layerEntry = capabilityLayers.find(
							(layer) => layer.Identifier === wmtsLayerId,
						);
						const fallbackEntry =
							layerEntry ?? (capabilityLayers.length === 1
								? capabilityLayers[0]
								: undefined);
						const resolvedLayerId = fallbackEntry?.Identifier ?? '';
						const matrixSet =
							fallbackEntry?.TileMatrixSetLink?.[0]?.TileMatrixSet ?? '';
						if (!resolvedLayerId || !matrixSet) {
							setError(
								capabilityLayers.length > 1
								? `Layer ${wmtsLayerId} not found in WMTS capabilities.`
								: `WMTS capabilities for ${layerId} did not include a valid layer.`,
							);
							return;
						}
						const options = optionsFromCapabilities(capabilities, {
							layer: resolvedLayerId,
							matrixSet,
						});
						if (!options) {
							setError(
								`Failed to build WMTS options for layer ${layerId}.`,
							);
							return;
						}
						const wmtsSource = new WMTS({
							...options,
							crossOrigin: 'anonymous',
							wrapX: true,
							tileLoadFunction: (tile, src) => {
								const image = (
									tile as unknown as { getImage: () => HTMLImageElement }
								).getImage();
								if (!apiKey) {
									image.src = src;
									return;
								}
								fetch(src, {
									headers: apiKey ? { 'x-api-key': apiKey } : undefined,
								})
									.then((response) => {
										if (!response.ok) {
											throw new Error(`HTTP ${response.status}`);
										}
										return response.blob();
									})
									.then((blob) => {
										const objectUrl = URL.createObjectURL(blob);
										image.onload = () => URL.revokeObjectURL(objectUrl);
										image.src = objectUrl;
									})
									.catch(() => {
										tile.setState(TileState.ERROR);
									});
							},
						});
						const existingLayer = layerMapRef.current.get(layerId);
						if (existingLayer) {
							existingLayer.setSource(wmtsSource);
							return;
						}
						const layer = new TileLayer({ source: wmtsSource, minZoom: -2 });
						layerMapRef.current.set(layerId, layer);
					} catch (error) {
						const cacheKey = `${wmtsMetadata.capabilitiesUrl}::${apiKey ?? ''}`;
						capabilitiesPromiseCache.delete(cacheKey);
						if (active) {
							const message =
								error instanceof Error ? error.message : 'Unknown error';
							setError(`Failed to load WMTS for ${layerId}: ${message}`);
						}
					}
				}),
			);
			if (!active) return;
			[...selectedLayers].reverse().forEach((layerId) => {
				const layer = layerMapRef.current.get(layerId);
				if (!layer) return;
				map.removeLayer(layer);
				map.getLayers().insertAt(0, layer);
			});
		};
		updateLayers();
		return () => {
			active = false;
		};
	}, [apiKey, enabled, mapRef, selectedLayers, wmtsMetadataByLayerId]);

	return { error };
}
