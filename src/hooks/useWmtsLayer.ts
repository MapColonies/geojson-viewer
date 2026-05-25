import { useEffect, useRef } from 'react';
import TileLayer from 'ol/layer/Tile';
import TileState from 'ol/TileState';
import WMTS, { optionsFromCapabilities } from 'ol/source/WMTS';
import type OlMap from 'ol/Map';

type UseWmtsLayerParams = {
	mapRef: React.RefObject<OlMap | null>;
	capabilities: Record<string, any> | null;
	selectedLayers: string[];
	apiKey?: string;
};

export function useWmtsLayer({
	mapRef,
	capabilities,
	selectedLayers,
	apiKey,
}: UseWmtsLayerParams) {
	const layerMapRef = useRef<Map<string, TileLayer<WMTS>>>(new Map());

	useEffect(() => {
		const map = mapRef.current;
		if (!map) return;
		if (!capabilities || selectedLayers.length === 0) {
			layerMapRef.current.forEach((layer: TileLayer<WMTS>) =>
				map.removeLayer(layer),
			);
			layerMapRef.current.clear();
			return;
		}

		const nextLayerIds = new Set(selectedLayers);
		layerMapRef.current.forEach((layer: TileLayer<WMTS>, layerId) => {
			if (!nextLayerIds.has(layerId)) {
				map.removeLayer(layer);
				layerMapRef.current.delete(layerId);
			}
		});

		const capabilityLayers = (capabilities?.Contents?.Layer ?? []) as {
			Identifier: string;
			TileMatrixSetLink?: { TileMatrixSet: string }[];
		}[];
		const resolveMatrixSetId = (layerId: string) => {
			const layerEntry = capabilityLayers.find(
				(layer) => layer.Identifier === layerId,
			);
			return layerEntry?.TileMatrixSetLink?.[0]?.TileMatrixSet ?? '';
		};

		selectedLayers.forEach((layerId) => {
			const matrixSet = resolveMatrixSetId(layerId);
			if (!matrixSet) return;
			const options = optionsFromCapabilities(capabilities, {
				layer: layerId,
				matrixSet,
			});
			if (!options) return;
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
			const layer = new TileLayer({ source: wmtsSource, minZoom: 0 });
			layerMapRef.current.set(layerId, layer);
		});

		[...selectedLayers].reverse().forEach((layerId) => {
			const layer = layerMapRef.current.get(layerId);
			if (!layer) return;
			map.removeLayer(layer);
			map.getLayers().insertAt(0, layer);
		});
	}, [apiKey, capabilities, mapRef, selectedLayers]);
}
