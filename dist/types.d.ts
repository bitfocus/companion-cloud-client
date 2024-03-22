export declare type CompanionAlignment = 'left:top' | 'center:top' | 'right:top' | 'left:center' | 'center:center' | 'right:center' | 'left:bottom' | 'center:bottom' | 'right:bottom';
export declare type CompanionTextSize = 'auto' | '7' | '14' | '18' | '24' | '30' | '44';
export interface ControlLocation {
    pageNumber: number;
    row: number;
    column: number;
}
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
export declare type SingleBank = {
    location: ControlLocation;
    /**
     * The page property is replaced by the location property for all future releases
     * @deprecated
     */
    page?: number;
    /**
     * The bank property is replaced by the location property for all future releases
     * @deprecated
     */
    bank?: number;
    p: number;
    data: CompanionButtonStyleProps;
};
export declare type MultiBank = SingleBank[];
