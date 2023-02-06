// Should be imported from companion somehow
export declare type CompanionAlignment = 'left:top' | 'center:top' | 'right:top' | 'left:center' | 'center:center' | 'right:center' | 'left:bottom' | 'center:bottom' | 'right:bottom';
export declare type CompanionTextSize = 'auto' | '7' | '14' | '18' | '24' | '30' | '44';
export interface CompanionImageBufferPosition {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface CompanionButtonStyleProps {
    text?: string;
    size?: CompanionTextSize;
    color?: number;
    bgcolor?: number;
    alignment?: CompanionAlignment;
    pngalignment?: CompanionAlignment;
    png64?: string;
	imageBuffer?: Uint8Array | string;
    imageBufferPosition?: CompanionImageBufferPosition;
}
export type SingleBank = {
	page: number
	bank: number
	data: CompanionButtonStyleProps
}

export type MultiBank = SingleBank[]